"""HTTP wrapper for the long-lived pose predictor service."""

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from exercise_rules import EXERCISES
import predictor
from predictor import DATA_ROOT, ROOT, create_pose_detector, handle_frame, load_models


def initialize_data_dir():
    DATA_ROOT.mkdir(parents=True, exist_ok=True)
    if DATA_ROOT == ROOT:
        return

    for name in ("models", "dataset"):
        target = DATA_ROOT / name
        if target.exists():
            continue
        source = ROOT / name
        if source.exists():
            shutil.copytree(source, target)
        else:
            target.mkdir()


class Handler(BaseHTTPRequestHandler):
    def _send(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-ML-Service-Key")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-ML-Service-Key")
        self.end_headers()

    def do_GET(self):
        if self.path == "/health":
            self._send(200, {"ok": True, "service": "ml"})
        elif self.path == "/exercises":
            exercises = {}
            for name, cfg in EXERCISES.items():
                model = predictor._models_cache.get(name)
                exercises[name] = {
                    "name": name,
                    "display_name": cfg["display_name"],
                    "icon": cfg["icon"],
                    "type": cfg["type"],
                    "rep_feature": cfg.get("rep_feature"),
                    "rep_down_below": cfg.get("rep_down_below"),
                    "rep_up_above": cfg.get("rep_up_above"),
                    "trained": model is not None,
                    "accuracy": (model or {}).get("meta", {}).get("accuracy") if model else None,
                    "n_samples": (model or {}).get("meta", {}).get("n_samples", 0) if model else 0,
                    "trained_at": (model or {}).get("meta", {}).get("trained_at") if model else None,
                }
            self._send(200, {"ok": True, "exercises": exercises})
        else:
            self._send(404, {"ok": False, "error": "Not found"})

    def do_POST(self):
        if os.environ.get("ML_SERVICE_KEY") and self.headers.get("X-ML-Service-Key") != os.environ["ML_SERVICE_KEY"]:
            self._send(401, {"ok": False, "error": "Unauthorized"})
            return

        length = int(self.headers.get("Content-Length", "0"))
        try:
            payload = json.loads(self.rfile.read(length))
        except (ValueError, json.JSONDecodeError):
            self._send(400, {"ok": False, "error": "Invalid JSON"})
            return

        if self.path == "/reload":
            load_models()
            self._send(200, {"ok": True, "reloaded": True})
            return
        if self.path == "/dataset":
            exercise = payload.get("exercise")
            label = payload.get("label") if payload.get("label") in ("correct", "incorrect") else "correct"
            filename = Path(payload.get("filename", "sample.bin")).name
            target = DATA_ROOT / "dataset" / exercise / label / filename
            target.parent.mkdir(parents=True, exist_ok=True)
            import base64
            target.write_bytes(base64.b64decode(payload.get("data", "")))
            self._send(200, {"ok": True, "saved": str(target.relative_to(DATA_ROOT))})
            return
        if self.path == "/train":
            args = [sys.executable, str(ROOT / "python" / "train.py")]
            if payload.get("all"):
                args.append("--all")
            else:
                args.extend(["--exercise", payload.get("exercise", "")])
            result = subprocess.run(args, cwd=ROOT / "python", capture_output=True, text=True, timeout=1200)
            line = next((item for item in reversed(result.stdout.splitlines()) if item.startswith("RESULT_JSON:")), None)
            if result.returncode != 0 or not line:
                self._send(500, {"ok": False, "error": result.stderr or "Training failed", "log": result.stdout})
                return
            initialize_data_dir()
            load_models()
            self._send(200, {"ok": True, "results": json.loads(line.replace("RESULT_JSON:", "")), "log": result.stdout})
            return
        if self.path != "/predict":
            self._send(404, {"ok": False, "error": "Not found"})
            return

        try:
            result = handle_frame(pose_detector, payload.get("exercise"), payload.get("image", ""))
            self._send(200, result)
        except Exception as exc:
            self._send(500, {"ok": False, "error": str(exc)})

    def log_message(self, *_args):
        return


load_models()
pose_detector = create_pose_detector(static_mode=False)
port = int(os.environ.get("PORT", "8000"))
print(f"ML service listening on port {port}", flush=True)
ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()