const crypto = require("crypto");
const db = require("../db/init");

// sessionId -> session state (all in-memory; lives only while the server runs)
const sessions = new Map();

function startSession({ userId, exercise, exerciseCfg, timerSeconds }) {
  const id = crypto.randomUUID();
  sessions.set(id, {
    id,
    userId,
    exercise,
    type: exerciseCfg.type, // "reps" | "hold"
    repFeature: exerciseCfg.rep_feature || null,
    repDownBelow: exerciseCfg.rep_down_below ?? null,
    repUpAbove: exerciseCfg.rep_up_above ?? null,
    timerSeconds: timerSeconds || null,
    startTime: Date.now(),
    lastFrameTime: Date.now(),
    reps: 0,
    repPhase: "up", // for rep-counting state machine
    holdSeconds: 0,
    totalFrames: 0,
    correctFrames: 0,
    bestAccuracy: 0,
  });
  return sessions.get(id);
}

function getSession(id) {
  return sessions.get(id);
}

/** Fold one predictor.py result into the session's running stats. */
function applyFrameResult(session, predictorResult) {
  const now = Date.now();
  const deltaSeconds = (now - session.lastFrameTime) / 1000;
  session.lastFrameTime = now;

  if (!predictorResult.person_detected) {
    return; // don't count "no person" frames toward accuracy
  }

  session.totalFrames += 1;
  if (predictorResult.correct === true) {
    session.correctFrames += 1;
  }

  if (predictorResult.confidence != null) {
    session.bestAccuracy = Math.max(session.bestAccuracy, predictorResult.confidence);
  }

  // Rep counting (reps-type exercises): watch the primary joint angle cross
  // the down/up thresholds, count one rep per down -> up cycle.
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

  // Hold counting (hold-type exercises): accumulate time spent in correct form
  if (session.type === "hold" && predictorResult.correct === true) {
    session.holdSeconds += deltaSeconds;
  }
}

function sessionAccuracyPercent(session) {
  if (session.totalFrames === 0) return 0;
  return (session.correctFrames / session.totalFrames) * 100;
}

function stopSession(id) {
  const session = sessions.get(id);
  if (!session) return null;

  const endedAt = Date.now();
  const durationSeconds = Math.round((endedAt - session.startTime) / 1000);
  const avgAccuracy = sessionAccuracyPercent(session);

  const stmt = db.prepare(`
    INSERT INTO workout_history
      (user_id, exercise, started_at, ended_at, duration_seconds, reps, hold_seconds,
       avg_accuracy, best_accuracy, frames_evaluated, frames_correct)
    VALUES (@userId, @exercise, @startedAt, @endedAt, @durationSeconds, @reps, @holdSeconds,
            @avgAccuracy, @bestAccuracy, @framesEvaluated, @framesCorrect)
  `);
  stmt.run({
    userId: session.userId,
    exercise: session.exercise,
    startedAt: new Date(session.startTime).toISOString(),
    endedAt: new Date(endedAt).toISOString(),
    durationSeconds,
    reps: session.type === "reps" ? session.reps : null,
    holdSeconds: session.type === "hold" ? Math.round(session.holdSeconds) : null,
    avgAccuracy,
    bestAccuracy: session.bestAccuracy * 100,
    framesEvaluated: session.totalFrames,
    framesCorrect: session.correctFrames,
  });

  sessions.delete(id);

  return {
    exercise: session.exercise,
    type: session.type,
    durationSeconds,
    reps: session.reps,
    holdSeconds: Math.round(session.holdSeconds),
    avgAccuracy,
    bestAccuracy: session.bestAccuracy * 100,
  };
}

module.exports = {
  startSession,
  getSession,
  applyFrameResult,
  sessionAccuracyPercent,
  stopSession,
};
