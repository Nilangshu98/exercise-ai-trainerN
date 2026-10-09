const crypto = require("crypto");
const db = require("../db/init");
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function startSession({ userId, exercise, exerciseCfg, timerSeconds }) {
  const session = {
    id: crypto.randomUUID(),
    userId,
    exercise,
    type: exerciseCfg.type,
    repFeature: exerciseCfg.rep_feature || null,
    repDownBelow: exerciseCfg.rep_down_below ?? null,
    repUpAbove: exerciseCfg.rep_up_above ?? null,
    timerSeconds: timerSeconds || null,
    startTime: Date.now(),
    lastFrameTime: Date.now(),
    reps: 0,
    repPhase: "up",
    holdSeconds: 0,
    totalFrames: 0,
    correctFrames: 0,
    bestAccuracy: 0,
  };

  await db.query(
    "INSERT INTO live_workouts (session_id, user_id, state) VALUES ($1, $2, $3::jsonb)",
    [session.id, userId, JSON.stringify(session)]
  );
  return session;
}

async function getSession(id, userId) {
  if (typeof id !== "string" || !UUID_PATTERN.test(id)) return null;
  const result = await db.query(
    "SELECT state FROM live_workouts WHERE session_id = $1 AND user_id = $2",
    [id, userId]
  );
  return result.rows[0]?.state || null;
}

async function saveSession(session) {
  await db.query(
    "UPDATE live_workouts SET state = $2::jsonb WHERE session_id = $1 AND user_id = $3",
    [session.id, JSON.stringify(session), session.userId]
  );
}

function applyFrameResult(session, predictorResult) {
  const now = Date.now();
  const deltaSeconds = (now - session.lastFrameTime) / 1000;
  session.lastFrameTime = now;

  if (!predictorResult.person_detected) return;

  session.totalFrames += 1;
  if (predictorResult.correct === true) session.correctFrames += 1;

  if (predictorResult.confidence != null) {
    session.bestAccuracy = Math.max(session.bestAccuracy, predictorResult.confidence);
  }

  if (session.type === "reps" && predictorResult.features && session.repFeature) {
    const value = predictorResult.features[session.repFeature];
    if (value != null) {
      if (session.repPhase === "up" && value < session.repDownBelow) {
        session.repPhase = "down";
      } else if (session.repPhase === "down" && value > session.repUpAbove) {
        session.repPhase = "up";
        session.reps += 1;
      }
    }
  }

  if (session.type === "hold" && predictorResult.correct === true) {
    session.holdSeconds += deltaSeconds;
  }
}

function sessionAccuracyPercent(session) {
  if (session.totalFrames === 0) return 0;
  return (session.correctFrames / session.totalFrames) * 100;
}

async function stopSession(id, userId) {
  if (typeof id !== "string" || !UUID_PATTERN.test(id)) return null;
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      "SELECT state FROM live_workouts WHERE session_id = $1 AND user_id = $2 FOR UPDATE",
      [id, userId]
    );
    const session = result.rows[0]?.state;
    if (!session) {
      await client.query("ROLLBACK");
      return null;
    }

    const endedAt = Date.now();
    const durationSeconds = Math.round((endedAt - session.startTime) / 1000);
    const avgAccuracy = sessionAccuracyPercent(session);

    await client.query(
      `INSERT INTO workout_history
        (user_id, exercise, started_at, ended_at, duration_seconds, reps, hold_seconds,
         avg_accuracy, best_accuracy, frames_evaluated, frames_correct)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        session.userId,
        session.exercise,
        new Date(session.startTime).toISOString(),
        new Date(endedAt).toISOString(),
        durationSeconds,
        session.type === "reps" ? session.reps : null,
        session.type === "hold" ? Math.round(session.holdSeconds) : null,
        avgAccuracy,
        session.bestAccuracy * 100,
        session.totalFrames,
        session.correctFrames,
      ]
    );
    await client.query("DELETE FROM live_workouts WHERE session_id = $1", [id]);
    await client.query("COMMIT");

    return {
      exercise: session.exercise,
      type: session.type,
      durationSeconds,
      reps: session.reps,
      holdSeconds: Math.round(session.holdSeconds),
      avgAccuracy,
      bestAccuracy: session.bestAccuracy * 100,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  startSession,
  getSession,
  saveSession,
  applyFrameResult,
  sessionAccuracyPercent,
  stopSession,
};
