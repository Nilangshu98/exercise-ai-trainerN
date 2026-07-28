const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");
const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const multer = require("multer");

const db = require("./db/init");
const PredictorClient = require("./lib/predictorClient");
const { getExercises, invalidateCache } = require("./lib/exerciseConfig");
const liveSessions = require("./lib/liveSessionManager");

const PORT = process.env.PORT || 3000;
const PYTHON_DIR = path.join(__dirname, "python");
const DATASET_DIR = path.join(__dirname, "dataset");

function _defaultPythonBin() {
  return process.platform === "win32" ? "python" : "python3";
}

const PYTHON_BIN = process.env.PYTHON_BIN || _defaultPythonBin();

const app = express();
app.use(express.json({ limit: "8mb" })); // webcam frames as base64 can be a few hundred KB
app.use(
  session({
    secret: process.env.SESSION_SECRET || "change-this-secret-in-production",
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }, // 7 days
  })
);

const predictor = new PredictorClient();

// ---------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------
function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ ok: false, error: "Not logged in" });
  }
  next();
}

// ---------------------------------------------------------------------
// Auth routes
// ---------------------------------------------------------------------
app.post("/api/auth/register", (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password || password.length < 4) {
    return res.status(400).json({
      ok: false,
      error: "Username and a password (4+ chars) are required.",
    });
  }
  const existing = db.prepare("SELECT id FROM users WHERE username = ?").get(username);
  if (existing) {
    return res.status(409).json({ ok: false, error: "That username is already taken." });
  }
  const hash = bcrypt.hashSync(password, 10);
  const info = db
    .prepare("INSERT INTO users (username, password_hash) VALUES (?, ?)")
    .run(username, hash);

  req.session.userId = info.lastInsertRowid;
  req.session.username = username;
  res.json({ ok: true, username });
});

app.post("/api/auth/login", (req, res) => {
  const { username, password } = req.body || {};
  const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username || "");
  if (!user || !bcrypt.compareSync(password || "", user.password_hash)) {
    return res.status(401).json({ ok: false, error: "Invalid username or password." });
  }
  req.session.userId = user.id;
  req.session.username = user.username;
  res.json({ ok: true, username: user.username });
});

app.post("/api/auth/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/auth/me", (req, res) => {
  if (!req.session.userId) return res.json({ ok: true, loggedIn: false });
  res.json({ ok: true, loggedIn: true, username: req.session.username });
});

// ---------------------------------------------------------------------
// Exercises
// ---------------------------------------------------------------------
app.get("/api/exercises", requireAuth, (req, res) => {
  try {
    res.json({ ok: true, exercises: getExercises() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------------------------------------------------------------------
// Training
// ---------------------------------------------------------------------
function runTrainingScript(args) {
  return new Promise((resolve, reject) => {
    execFile(
      PYTHON_BIN,
      ["train.py", ...args],
      { cwd: PYTHON_DIR, maxBuffer: 20 * 1024 * 1024, timeout: 20 * 60 * 1000 },
      (error, stdout, stderr) => {
        const line = stdout
          .split("\n")
          .reverse()
          .find((l) => l.startsWith("RESULT_JSON:"));
        if (line) {
          try {
            resolve({ results: JSON.parse(line.replace("RESULT_JSON:", "")), log: stdout });
            return;
          } catch (e) {
            // fall through to error handling below
          }
        }
        reject(new Error(stderr || error?.message || "Training script produced no result"));
      }
    );
  });
}

app.post("/api/train/:exercise", requireAuth, async (req, res) => {
  const { exercise } = req.params;
  try {
    const { results, log } = await runTrainingScript(["--exercise", exercise]);
    invalidateCache();
    await predictor.reloadModels();
    res.json({ ok: true, result: results[0], log });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/train-all", requireAuth, async (req, res) => {
  try {
    const { results, log } = await runTrainingScript(["--all"]);
    invalidateCache();
    await predictor.reloadModels();
    res.json({ ok: true, results, log });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Optional convenience: upload a training sample straight from the browser
// into dataset/<exercise>/<correct|incorrect>/. Useful for growing a
// dataset without touching the filesystem directly.
const upload = multer({ limits: { fileSize: 200 * 1024 * 1024 } });
app.post("/api/dataset/:exercise/upload", requireAuth, upload.single("file"), (req, res) => {
  const { exercise } = req.params;
  const label = req.body.label === "incorrect" ? "incorrect" : "correct";
  const exercises = getExercises();
  if (!exercises[exercise]) {
    return res.status(400).json({ ok: false, error: `Unknown exercise '${exercise}'` });
  }
  if (!req.file) {
    return res.status(400).json({ ok: false, error: "No file uploaded" });
  }
  const dir = path.join(DATASET_DIR, exercise, label);
  fs.mkdirSync(dir, { recursive: true });
  const safeName = `${Date.now()}-${req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
  fs.writeFileSync(path.join(dir, safeName), req.file.buffer);
  res.json({ ok: true, saved: `${exercise}/${label}/${safeName}` });
});

// ---------------------------------------------------------------------
// Live detection
// ---------------------------------------------------------------------
app.post("/api/live/start", requireAuth, (req, res) => {
  const { exercise, timerSeconds } = req.body || {};
  const exercises = getExercises();
  const cfg = exercises[exercise];
  if (!cfg) {
    return res.status(400).json({ ok: false, error: `Unknown exercise '${exercise}'` });
  }
  if (!cfg.trained) {
    return res.status(400).json({
      ok: false,
      error: `'${cfg.display_name}' hasn't been trained yet. Go to the Train page first.`,
    });
  }

  // pull rep-counting thresholds fresh from python config (cached in getExercises
  // only covers status, so re-read raw config for thresholds too)
  const raw = JSON.parse(
    require("child_process").execFileSync(
      PYTHON_BIN,
      ["list_exercises.py"],
      { cwd: PYTHON_DIR, encoding: "utf-8" }
    )
  )[exercise];

  const session = liveSessions.startSession({
    userId: req.session.userId,
    exercise,
    exerciseCfg: raw,
    timerSeconds,
  });

  res.json({ ok: true, sessionId: session.id, type: session.type });
});

app.post("/api/live/frame", requireAuth, async (req, res) => {
  const { sessionId, image } = req.body || {};
  const session = liveSessions.getSession(sessionId);
  if (!session) {
    return res.status(404).json({ ok: false, error: "Session not found or already stopped" });
  }
  if (session.userId !== req.session.userId) {
    return res.status(403).json({ ok: false, error: "Not your session" });
  }

  try {
    const result = await predictor.call({ exercise: session.exercise, image });
    if (!result.ok) {
      return res.status(500).json({ ok: false, error: result.error });
    }

    liveSessions.applyFrameResult(session, result);

    const elapsedSeconds = (Date.now() - session.startTime) / 1000;
    const remainingSeconds = session.timerSeconds
      ? Math.max(0, session.timerSeconds - elapsedSeconds)
      : null;

    res.json({
      ok: true,
      personDetected: result.person_detected,
      landmarks: result.landmarks,
      features: result.features,
      correct: result.correct,
      confidence: result.confidence,
      tips: result.tips,
      modelAvailable: result.model_available,
      reps: session.reps,
      holdSeconds: Math.round(session.holdSeconds),
      elapsedSeconds: Math.round(elapsedSeconds),
      remainingSeconds: remainingSeconds != null ? Math.round(remainingSeconds) : null,
      timerExpired: remainingSeconds != null && remainingSeconds <= 0,
      sessionAccuracyPercent: liveSessions.sessionAccuracyPercent(session),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/live/stop", requireAuth, (req, res) => {
  const { sessionId } = req.body || {};
  const summary = liveSessions.stopSession(sessionId);
  if (!summary) {
    return res.status(404).json({ ok: false, error: "Session not found" });
  }
  res.json({ ok: true, summary });
});

// ---------------------------------------------------------------------
// History
// ---------------------------------------------------------------------
app.get("/api/history", requireAuth, (req, res) => {
  const rows = db
    .prepare(
      `SELECT exercise, started_at, ended_at, duration_seconds, reps, hold_seconds,
              avg_accuracy, best_accuracy
       FROM workout_history WHERE user_id = ?
       ORDER BY id DESC LIMIT 50`
    )
    .all(req.session.userId);
  res.json({ ok: true, history: rows });
});

// ---------------------------------------------------------------------
// Admin (opt-in)
// Protect with an environment variable ADMIN_SECRET. Supply via
// `x-admin-secret` header or `admin_secret` query param.
// This adds read-only introspection endpoints and a static admin page.
// ---------------------------------------------------------------------
app.get("/api/admin/stats", requireAdmin, (req, res) => {
  // total users
  const totalUsers = db.prepare("SELECT COUNT(*) as c FROM users").get().c;

  // active live sessions (in-memory)
  let activeLiveSessions = null;
  try {
    if (liveSessions && typeof liveSessions.listSessions === "function") {
      activeLiveSessions = liveSessions.listSessions().length;
    }
  } catch (e) {
    activeLiveSessions = null;
  }

  // logged-in sessions via session store (may be memory store or other stores)
  const store = req.sessionStore;
  if (!store || typeof store.all !== "function") {
    // can't enumerate sessions on this store
    return res.json({ ok: true, totalUsers, loggedInSessions: null, activeLiveSessions });
  }

  store.all((err, sessionsObj) => {
    if (err) return res.status(500).json({ ok: false, error: err.message });
    let loggedIn = 0;
    try {
      for (const k of Object.keys(sessionsObj)) {
        const s = sessionsObj[k];
        // session stores may return stringified JSON or object
        const parsed = typeof s === "string" ? JSON.parse(s) : s;
        if (parsed && parsed.userId) loggedIn += 1;
      }
    } catch (e) {
      // ignore parse errors
    }

    const recentWorkouts = db.prepare("SELECT COUNT(*) as c FROM workout_history").get().c;

    res.json({
      ok: true,
      totalUsers,
      loggedInSessions: loggedIn,
      activeLiveSessions,
      recentWorkouts,
    });
  });
});

// ---------------------------------------------------------------------
// Static frontend
// ---------------------------------------------------------------------
app.use(express.static(path.join(__dirname, "public")));

// ---------------------------------------------------------------------
// Admin auth helpers (restored)
// ---------------------------------------------------------------------
function requireAdmin(req, res, next) {
  // fall back to ADMIN_SECRET header/query
  const adminSecret = process.env.ADMIN_SECRET;
  const provided = req.get("x-admin-secret") || req.query.admin_secret;
  if (adminSecret && provided === adminSecret) return next();

  // session-based admin (optional)
  if (req.session && req.session.isAdmin) return next();

  return res.status(401).json({ ok: false, error: "Unauthorized" });
}

app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ ok: false, error: 'username and password required' });
  try {
    const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(username);
    if (!admin || !bcrypt.compareSync(password, admin.password_hash)) {
      return res.status(401).json({ ok: false, error: 'Invalid credentials' });
    }
    req.session.isAdmin = true;
    req.session.adminUsername = admin.username;
    res.json({ ok: true, username: admin.username });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/admin/logout', (req, res) => {
  if (req.session) {
    req.session.isAdmin = false;
    delete req.session.adminUsername;
  }
  res.json({ ok: true });
});


if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Exercise AI Trainer running at http://localhost:${PORT}`);
  });
}

module.exports = app;
