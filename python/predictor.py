"""
predictor.py — long-lived inference worker.

The Node.js server spawns ONE instance of this process when it starts, and
keeps it alive for the whole life of the server (much faster than starting
a fresh Python process per video frame). Communication is newline-delimited
JSON over stdin/stdout:

  stdin  (one line per video frame):
    {"exercise": "squat", "image": "<base64 jpeg, no data-uri prefix>"}

  stdin  (hot-reload models after (re)training, no restart needed):
    {"cmd": "reload"}

  stdout (one line per response):
    {
      "ok": true,
      "person_detected": true,
      "landmarks": [{"x":..,"y":..,"z":..,"visibility":..}, ...] | null,
      "features": {"knee_angle": 92.1, "back_angle": 41.3},
      "model_available": true,
      "correct": true,
      "confidence": 0.91,
      "tips": ["Great form!"]
    }

Every response is exactly one line so the Node side can just do
`line = line.trim(); JSON.parse(line)`.
"""

import base64
import json
import sys
import os
from pathlib import Path

import cv2
import joblib
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from exercise_rules import EXERCISES, get_exercise
from pose_model import create_pose_detector
from pose_utils import landmarks_to_list

ROOT = Path(__file__).resolve().parent.parent
MODELS_DIR = ROOT / "models"

TIP_ZSCORE_THRESHOLD = 1.0  # how many std-devs away from "correct" mean counts as "fix this"

_models_cache = {}  # exercise -> {"model":..,"scaler":..,"meta":..} or None


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def load_models():
    global _models_cache
    _models_cache = {}
    for name in EXERCISES:
        model_path = MODELS_DIR / f"{name}_model.pkl"
        scaler_path = MODELS_DIR / f"{name}_scaler.pkl"
        meta_path = MODELS_DIR / f"{name}_meta.json"
        if model_path.exists() and scaler_path.exists() and meta_path.exists():
            try:
                _models_cache[name] = {
                    "model": joblib.load(model_path),
                    "scaler": joblib.load(scaler_path),
                    "meta": json.loads(meta_path.read_text()),
                }
                log(f"Loaded model for '{name}'")
            except Exception as e:
                log(f"Failed loading model for '{name}': {e}")
                _models_cache[name] = None
        else:
            _models_cache[name] = None


def decode_image(b64_str):
    if "," in b64_str[:60]:  # strip a data:image/jpeg;base64, prefix if present
        b64_str = b64_str.split(",", 1)[1]
    raw = base64.b64decode(b64_str)
    arr = np.frombuffer(raw, dtype=np.uint8)
    frame = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    return frame


def build_tips(cfg, features, meta):
    tips = []
    stats = (meta or {}).get("correct_feature_stats", {})
    for fname in cfg["feature_order"]:
        if fname not in stats or fname not in features:
            continue
        mean = stats[fname]["mean"]
        std = stats[fname]["std"] or 1e-6
        z = (features[fname] - mean) / std
        tip_templates = cfg["tips"].get(fname, {})
        if z < -TIP_ZSCORE_THRESHOLD and "low" in tip_templates:
            tips.append(tip_templates["low"])
        elif z > TIP_ZSCORE_THRESHOLD and "high" in tip_templates:
            tips.append(tip_templates["high"])
    if not tips:
        tips.append("Great form!")
    return tips[:3]


def handle_frame(pose_detector, exercise, image_b64):
    if exercise not in EXERCISES:
        return {"ok": False, "error": f"Unknown exercise '{exercise}'"}

    frame = decode_image(image_b64)
    if frame is None:
        return {"ok": False, "error": "Could not decode image"}

    cfg = get_exercise(exercise)
    landmarks = pose_detector.process(frame)

    if landmarks is None:
        return {
            "ok": True,
            "person_detected": False,
            "landmarks": None,
            "features": None,
            "model_available": exercise in _models_cache and _models_cache[exercise] is not None,
            "correct": None,
            "confidence": None,
            "tips": ["No person detected — step into frame."],
        }

    features = cfg["extract"](landmarks)
    entry = _models_cache.get(exercise)

    result = {
        "ok": True,
        "person_detected": True,
        "landmarks": landmarks_to_list(landmarks),
        "features": features,
        "model_available": entry is not None,
        "correct": None,
        "confidence": None,
        "tips": [],
        "feedback": None,
        "status": None,
    }

    if entry is not None:
        model, scaler, meta = entry["model"], entry["scaler"], entry["meta"]
        feature_order = meta["feature_order"]
        X = np.array([[features[f] for f in feature_order]], dtype=float)
        X_scaled = scaler.transform(X)
        pred = model.predict(X_scaled)[0]
        proba = model.predict_proba(X_scaled)[0]
        confidence = float(proba[pred])
        result["correct"] = bool(pred == 1)
        result["confidence"] = confidence
        result["tips"] = build_tips(cfg, features, meta)
    else:
        result["tips"] = [f"'{cfg['display_name']}' hasn't been trained yet. "
                           f"Add sample images/videos and train it on the Train page."]

    result["feedback"] = result["tips"][0] if result["tips"] else ""
    if not result["person_detected"]:
        result["status"] = "wrong"
    elif not result["model_available"]:
        result["status"] = "wrong"
    elif result["correct"] is True:
        result["status"] = "correct"
    elif result["confidence"] is not None and result["confidence"] >= 0.6:
        result["status"] = "warning"
    else:
        result["status"] = "wrong"

    return result


def main():
    load_models()
    pose_detector = create_pose_detector(static_mode=False)
    log("predictor ready")

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            print(json.dumps({"ok": False, "error": "invalid JSON request"}), flush=True)
            continue

        try:
            if req.get("cmd") == "reload":
                load_models()
                print(json.dumps({"ok": True, "reloaded": True}), flush=True)
                continue

            resp = handle_frame(pose_detector, req.get("exercise"), req.get("image", ""))
            print(json.dumps(resp), flush=True)
        except Exception as e:
            print(json.dumps({"ok": False, "error": str(e)}), flush=True)


if __name__ == "__main__":
    main()
