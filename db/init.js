const { Pool } = require("pg");

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL must be set to a PostgreSQL connection string.");
}

const pool = new Pool({
  connectionString,
  max: Number(process.env.PG_POOL_MAX || 1),
  ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
});

let schemaPromise;

function initialize() {
  if (!schemaPromise) {
    schemaPromise = pool
      .query(`
        CREATE TABLE IF NOT EXISTS users (
          id SERIAL PRIMARY KEY,
          username TEXT UNIQUE NOT NULL,
          password_hash TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS workout_history (
          id BIGSERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          exercise TEXT NOT NULL,
          started_at TIMESTAMPTZ NOT NULL,
          ended_at TIMESTAMPTZ NOT NULL,
          duration_seconds INTEGER NOT NULL,
          reps INTEGER,
          hold_seconds INTEGER,
          avg_accuracy DOUBLE PRECISION,
          best_accuracy DOUBLE PRECISION,
          frames_evaluated INTEGER,
          frames_correct INTEGER
        );

        CREATE INDEX IF NOT EXISTS idx_history_user ON workout_history(user_id);

        CREATE TABLE IF NOT EXISTS live_workouts (
          session_id UUID PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          state JSONB NOT NULL
        );
      `)
      .catch((error) => {
        schemaPromise = null;
        throw error;
      });
  }
  return schemaPromise;
}

module.exports = { initialize, pool, query: (...args) => pool.query(...args) };
