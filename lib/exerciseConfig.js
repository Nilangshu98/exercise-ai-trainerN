const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const PYTHON_DIR = path.join(__dirname, "..", "python");
const MODELS_DIR = path.join(__dirname, "..", "models");

function _defaultPythonBin() {
  return process.platform === "win32" ? "python" : "python3";
}

const PYTHON_BIN = process.env.PYTHON_BIN || _defaultPythonBin();

let _cache = null;

function loadBaseConfig() {
  const out = execFileSync(PYTHON_BIN, ["list_exercises.py"], {
    cwd: PYTHON_DIR,
    encoding: "utf-8",
  });
  return JSON.parse(out);
}

/** Returns { squat: {display_name, icon, type, trained, accuracy, ...}, ... } */
function getExercises({ forceRefresh = false } = {}) {
  if (_cache && !forceRefresh) return _cache;

  const base = loadBaseConfig();
  const result = {};
  for (const [name, cfg] of Object.entries(base)) {
    const metaPath = path.join(MODELS_DIR, `${name}_meta.json`);
    const modelPath = path.join(MODELS_DIR, `${name}_model.pkl`);
    let meta = null;
    if (fs.existsSync(metaPath) && fs.existsSync(modelPath)) {
      try {
        meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
      } catch (e) {
        meta = null;
      }
    }
    result[name] = {
      name,
      display_name: cfg.display_name,
      icon: cfg.icon,
      type: cfg.type, // "reps" | "hold"
      rep_feature: cfg.rep_feature || null,
      rep_down_below: cfg.rep_down_below ?? null,
      rep_up_above: cfg.rep_up_above ?? null,
      trained: !!meta,
      accuracy: meta ? meta.accuracy : null,
      n_samples: meta ? meta.n_samples : 0,
      trained_at: meta ? meta.trained_at : null,
    };
  }
  _cache = result;
  return result;
}

function invalidateCache() {
  _cache = null;
}

module.exports = { getExercises, invalidateCache };
