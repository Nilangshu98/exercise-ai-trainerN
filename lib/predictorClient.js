const { spawn } = require("child_process");
const readline = require("readline");
const path = require("path");

const PYTHON_DIR = path.join(__dirname, "..", "python");

function _defaultPythonBin() {
  return process.platform === "win32" ? "python" : "python3";
}

const PYTHON_BIN = process.env.PYTHON_BIN || _defaultPythonBin();

function _pythonCandidates() {
  const candidates = [];
  if (process.env.PYTHON_BIN) candidates.push(process.env.PYTHON_BIN);
  // prefer the configured/default names
  candidates.push(process.platform === "win32" ? "python" : "python3");
  candidates.push(process.platform === "win32" ? "python3" : "python");
  // common Windows install locations
  if (process.platform === "win32") {
    candidates.push(path.join(process.env["ProgramFiles"] || "C:\\Program Files", "Python310", "python.exe"));
    candidates.push(path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Python310", "python.exe"));
    candidates.push(path.join(process.env.HOME || process.env.USERPROFILE || "", "AppData", "Local", "Programs", "Python", "Python310", "python.exe"));
  }
  return Array.from(new Set(candidates)).filter(Boolean);
}

/**
 * Talks to python/predictor.py over stdin/stdout (newline-delimited JSON).
 * Requests are answered strictly in the order they were sent, so a simple
 * FIFO queue of pending Promises is enough to match responses to callers -
 * no need for request IDs.
 */
class PredictorClient {
  constructor() {
    this.child = null;
    this.pending = [];
    this.ready = false;
    this._start();
  }

  _start() {
    console.log("Starting Python predictor subprocess...");

    const candidates = _pythonCandidates();
    let started = false;

    const tryStart = (i) => {
      if (i >= candidates.length) {
        console.error("Failed to start Python predictor: no candidate executables found");
        return;
      }
      const bin = candidates[i];
      try {
        const child = spawn(bin, ["predictor.py"], {
          cwd: PYTHON_DIR,
          stdio: ["pipe", "pipe", "pipe"],
        });

        child.on("error", (err) => {
          if (err && err.code === "ENOENT") {
            console.warn(`Python executable '${bin}' not found, trying next candidate`);
            tryStart(i + 1);
            return;
          }
          console.error(`Failed to start predictor using '${bin}':`, err.message || err);
        });

        // if spawn succeeded, attach child streams and swap in
        this.child = child;
        started = true;
      } catch (e) {
        console.warn(`Spawn threw for '${bin}', trying next candidate`);
        tryStart(i + 1);
      }
    };

    tryStart(0);

    if (!this.child) return; // will have started async or exhausted

    const rl = readline.createInterface({ input: this.child.stdout });
    rl.on("line", (line) => {
      line = line.trim();
      if (!line) return;
      const resolver = this.pending.shift();
      if (!resolver) {
        console.warn("Predictor sent a response with no pending request:", line);
        return;
      }
      try {
        resolver.resolve(JSON.parse(line));
      } catch (e) {
        resolver.reject(new Error("Predictor returned invalid JSON: " + line));
      }
    });

    this.child.stderr.on("data", (buf) => {
      const text = buf.toString();
      // predictor.py logs progress/errors to stderr - surface it, but don't
      // treat it as fatal.
      process.stderr.write(`[predictor] ${text}`);
      if (text.includes("predictor ready")) this.ready = true;
    });

    this.child.on("exit", (code) => {
      console.error(`Predictor subprocess exited with code ${code}. Restarting...`);
      this.ready = false;
      // fail any in-flight requests
      this.pending.forEach((p) => p.reject(new Error("Predictor process crashed")));
      this.pending = [];
      setTimeout(() => this._start(), 1000);
    });
  }

  /** Send one request object, get back one response object. */
  call(requestObj) {
    return new Promise((resolve, reject) => {
      if (!this.child || this.child.killed) {
        reject(new Error("Predictor process is not running"));
        return;
      }
      this.pending.push({ resolve, reject });
      this.child.stdin.write(JSON.stringify(requestObj) + "\n");
    });
  }

  reloadModels() {
    return this.call({ cmd: "reload" });
  }
}

module.exports = PredictorClient;
