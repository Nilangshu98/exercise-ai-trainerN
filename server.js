require("dotenv").config();

const path = require("path");
const fs = require("fs");
const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const multer = require("multer");

const db = require("./db/init");
const PredictorClient = require("./lib/predictorClient");
const { getExercises, invalidateCache } = require("./lib/exerciseConfig");
const liveSessions = require("./lib/liveSessionManager");

const PORT = process.env.PORT || 3000;
const FRONTEND_URLS = (process.env.FRONTEND_URLS || "http://localhost:3000")
  .split(",")
  .map((url) => url.trim())
  .filter(Boolean);

const app = express();
app.set("trust proxy", 1);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && FRONTEND_URLS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: "8mb" })); // webcam frames as base64 can be a few hundred KB
app.use(
  session({
    secret: process.env.SESSION_SECRET || "change-this-secret-in-production",
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 7 * 24 * 60 * 60 * 1000,
      sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
      secure: process.env.NODE_ENV === "production",
    },
  })
);

const predictor = new PredictorClient();

app.get("/health", (req, res) => res.json({ ok: true, service: "backend" }));

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
app.get("/api/exercises", requireAuth, async (req, res) => {
  try {
    res.json({ ok: true, exercises: await getExercises() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------------------------------------------------------------------
// Training
// ---------------------------------------------------------------------
function runTrainingScript(args) {
  return predictor.train(args.includes("--all") ? { all: true } : { exercise: args[1] });
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
app.post("/api/dataset/:exercise/upload", requireAuth, upload.single("file"), async (req, res) => {
  const { exercise } = req.params;
  const label = req.body.label === "incorrect" ? "incorrect" : "correct";
  const exercises = await getExercises();
  if (!exercises[exercise]) {
    return res.status(400).json({ ok: false, error: `Unknown exercise '${exercise}'` });
  }
  if (!req.file) {
    return res.status(400).json({ ok: false, error: "No file uploaded" });
  }
  const safeName = `${Date.now()}-${req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
  const result = await predictor.uploadDataset({
    exercise,
    label,
    filename: safeName,
    data: req.file.buffer.toString("base64"),
  });
  res.json(result);
});

// ---------------------------------------------------------------------
// Live detection
// ---------------------------------------------------------------------
app.post("/api/live/start", requireAuth, async (req, res) => {
  const { exercise, timerSeconds } = req.body || {};
  const exercises = await getExercises();
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

  const session = liveSessions.startSession({
    userId: req.session.userId,
    exercise,
    exerciseCfg: cfg,
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
// Static frontend
// ---------------------------------------------------------------------
app.use(express.static(path.join(__dirname, "public")));

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Exercise AI Trainer running at http://localhost:${PORT}`);
  });
}

module.exports = app;
