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
const IS_PRODUCTION = process.env.NODE_ENV === "production" || Boolean(process.env.VERCEL);
if (IS_PRODUCTION && !process.env.SESSION_SECRET) {
  throw new Error("SESSION_SECRET must be set in production.");
}
if (IS_PRODUCTION && !process.env.ML_SERVICE_URL) {
  throw new Error("ML_SERVICE_URL must be set in production.");
}

const app = express();
app.set("trust proxy", 1);
app.use(async (req, res, next) => {
  try {
    await db.initialize();
    next();
  } catch (error) {
    console.error("Database initialization failed:", error);
    res.status(503).json({ ok: false, error: "Database unavailable" });
  }
});
app.use(express.json({ limit: process.env.VERCEL ? "4mb" : "8mb" }));
app.use(
  session({
    secret: process.env.SESSION_SECRET || "change-this-secret-in-production",
    resave: false,
    saveUninitialized: false,
    store: new (require("connect-pg-simple")(session))({
      pool: db.pool,
      tableName: "user_sessions",
      createTableIfMissing: true,
    }),
    cookie: {
      maxAge: 7 * 24 * 60 * 60 * 1000,
      sameSite: "lax",
      secure: IS_PRODUCTION,
      httpOnly: true,
    },
  })
);

const predictor = new PredictorClient();

app.get("/health", (req, res) => res.json({ ok: true, service: "backend" }));
app.get("/api/health", (req, res) => res.json({ ok: true, service: "backend" }));

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
app.post("/api/auth/register", async (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== "string" || typeof password !== "string" || password.length < 4) {
    return res.status(400).json({
      ok: false,
      error: "Username and a password (4+ chars) are required.",
    });
  }
  try {
    const hash = bcrypt.hashSync(password, 10);
    const result = await db.query(
      "INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id",
      [username, hash]
    );
    req.session.userId = result.rows[0].id;
    req.session.username = username;
    res.json({ ok: true, username });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({ ok: false, error: "That username is already taken." });
    }
    console.error("Registration failed:", error);
    res.status(500).json({ ok: false, error: "Could not create account." });
  }
});

app.post("/api/auth/login", async (req, res) => {
  const { username, password } = req.body || {};
  try {
    const result = await db.query("SELECT * FROM users WHERE username = $1", [
      typeof username === "string" ? username : "",
    ]);
    const user = result.rows[0];
    if (!user || !bcrypt.compareSync(typeof password === "string" ? password : "", user.password_hash)) {
      return res.status(401).json({ ok: false, error: "Invalid username or password." });
    }
    req.session.userId = user.id;
    req.session.username = user.username;
    res.json({ ok: true, username: user.username });
  } catch (error) {
    console.error("Login failed:", error);
    res.status(500).json({ ok: false, error: "Could not sign in." });
  }
});

app.post("/api/auth/logout", (req, res) => {
  req.session.destroy((error) => {
    if (error) {
      console.error("Logout failed:", error);
      return res.status(500).json({ ok: false, error: "Could not sign out." });
    }
    res.json({ ok: true });
  });
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
const upload = multer({ limits: { fileSize: process.env.VERCEL ? 3 * 1024 * 1024 : 200 * 1024 * 1024 } });
app.post("/api/dataset/:exercise/upload", requireAuth, upload.single("file"), async (req, res) => {
  try {
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
  } catch (error) {
    console.error("Dataset upload failed:", error);
    res.status(502).json({ ok: false, error: "Could not upload the sample to the ML service." });
  }
});

// ---------------------------------------------------------------------
// Live detection
// ---------------------------------------------------------------------
app.post("/api/live/start", requireAuth, async (req, res) => {
  try {
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

    const session = await liveSessions.startSession({
      userId: req.session.userId,
      exercise,
      exerciseCfg: cfg,
      timerSeconds,
    });

    res.json({ ok: true, sessionId: session.id, type: session.type });
  } catch (e) {
    res.status(503).json({ ok: false, error: `Workout service unavailable: ${e.message}` });
  }
});

app.post("/api/live/frame", requireAuth, async (req, res) => {
  const { sessionId, image } = req.body || {};
  try {
    const session = await liveSessions.getSession(sessionId, req.session.userId);
    if (!session) {
      return res.status(404).json({ ok: false, error: "Session not found or already stopped" });
    }
    const result = await predictor.call({ exercise: session.exercise, image });
    if (!result.ok) {
      return res.status(500).json({ ok: false, error: result.error });
    }

    liveSessions.applyFrameResult(session, result);
    await liveSessions.saveSession(session);

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

app.post("/api/live/stop", requireAuth, async (req, res) => {
  try {
    const { sessionId } = req.body || {};
    const summary = await liveSessions.stopSession(sessionId, req.session.userId);
    if (!summary) {
      return res.status(404).json({ ok: false, error: "Session not found" });
    }
    res.json({ ok: true, summary });
  } catch (error) {
    console.error("Workout save failed:", error);
    res.status(500).json({ ok: false, error: "Could not save workout history." });
  }
});

// ---------------------------------------------------------------------
// History
// ---------------------------------------------------------------------
app.get("/api/history", requireAuth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT exercise, started_at, ended_at, duration_seconds, reps, hold_seconds,
              avg_accuracy, best_accuracy
       FROM workout_history WHERE user_id = $1
       ORDER BY id DESC LIMIT 50`,
      [req.session.userId]
    );
    res.json({ ok: true, history: result.rows });
  } catch (error) {
    console.error("History lookup failed:", error);
    res.status(500).json({ ok: false, error: "Could not load workout history." });
  }
});

// ---------------------------------------------------------------------
// Static frontend
// ---------------------------------------------------------------------
app.use(express.static(path.join(__dirname, "public")));
app.use((error, req, res, next) => {
  console.error("Request failed:", error);
  if (res.headersSent) return next(error);
  if (error.code === "LIMIT_FILE_SIZE") {
    const message = process.env.VERCEL
      ? "Sample uploads are limited to 3 MB on Vercel."
      : "Sample upload exceeds the configured size limit.";
    return res.status(413).json({ ok: false, error: message });
  }
  if (error.status === 413 || error.statusCode === 413) {
    return res.status(413).json({ ok: false, error: "Request body exceeds the serverless size limit." });
  }
  res.status(500).json({ ok: false, error: "Internal server error" });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Exercise AI Trainer running at http://localhost:${PORT}`);
  });
}

module.exports = app;
