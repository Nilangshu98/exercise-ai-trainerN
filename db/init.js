const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

const DB_PATH = path.join(__dirname, "app.sqlite");
const isNew = !fs.existsSync(DB_PATH);

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS workout_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    exercise TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT NOT NULL,
    duration_seconds INTEGER NOT NULL,
    reps INTEGER,
    hold_seconds INTEGER,
    avg_accuracy REAL,
    best_accuracy REAL,
    frames_evaluated INTEGER,
    frames_correct INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_history_user ON workout_history(user_id);
`);

db.exec("DROP TABLE IF EXISTS admins");

if (isNew) {
  console.log(`Created new database at ${DB_PATH}`);
}

module.exports = db;
