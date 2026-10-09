"""
train.py — trains one Random Forest "form correctness" model per exercise.

Usage:
    python train.py --exercise squat
    python train.py --all

For each exercise it:
  1. Walks dataset/<exercise>/ looking for images (.jpg/.jpeg/.png/.bmp) and
     videos (.mp4/.avi/.mov/.mkv/.webm), either inside correct/ and
     incorrect/ subfolders, OR flat files named like "correct_1.jpg" /
     "incorrect_2.mp4".
  2. Runs MediaPipe Pose on each image (and on sampled frames from each
     video) to get body landmarks.
  3. Converts landmarks into the joint-angle features defined for that
     exercise in exercise_rules.py.
  4. Trains a RandomForestClassifier to distinguish correct vs incorrect
     form, saves it + a scaler + metadata to models/.

Prints progress and a final JSON summary line (prefixed "RESULT_JSON:") so
the Node.js backend can capture structured results when it spawns this
script.
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path

import cv2
import joblib
import numpy as np
from sklearn.ensemble import RandomForestClassifier
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import accuracy_score

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from exercise_rules import EXERCISES, get_exercise, list_exercise_names
from pose_utils import IMAGE_EXTENSIONS, VIDEO_EXTENSIONS
from pose_model import create_pose_detector

ROOT = Path(__file__).resolve().parent.parent
DATA_ROOT = Path(os.environ.get("APP_DATA_DIR", ROOT)).resolve()
DATASET_DIR = DATA_ROOT / "dataset"
MODELS_DIR = DATA_ROOT / "models"
MODELS_DIR.mkdir(exist_ok=True)

MAX_FRAMES_PER_VIDEO = 40  # cap so a long video doesn't dominate the dataset


def infer_label(path: Path) -> str:
    """'correct' or 'incorrect', from parent folder name or filename prefix."""
    parts = [p.lower() for p in path.parts]
    name = path.name.lower()
    if "incorrect" in parts or name.startswith("incorrect"):
        return "incorrect"
    if "correct" in parts or name.startswith("correct"):
        return "correct"
    # default: assume correct if unlabeled (so users can just drop good-form
    # samples straight into the exercise folder without extra structure)
    return "correct"


def find_samples(exercise_dir: Path):
    samples = []
    if not exercise_dir.exists():
        return samples
    for path in exercise_dir.rglob("*"):
        if not path.is_file():
            continue
        if ".ipynb_checkpoints" in path.parts or path.name.startswith("."):
            continue
        ext = path.suffix.lower()
        if ext in IMAGE_EXTENSIONS or ext in VIDEO_EXTENSIONS:
            samples.append((path, infer_label(path), ext in VIDEO_EXTENSIONS))
    return samples


def extract_features_from_frame(pose_model, frame_bgr, extract_fn):
    landmarks = pose_model.process(frame_bgr)
    if landmarks is None:
        return None
    return extract_fn(landmarks)


def rows_from_image(pose_model, path: Path, extract_fn):
    image = cv2.imread(str(path))
    if image is None:
        print(f"  ⚠️  Could not read image: {path.name}")
        return []
    feats = extract_features_from_frame(pose_model, image, extract_fn)
    if feats is None:
        print(f"  ⚠️  No pose detected: {path.name}")
        return []
    return [feats]


def rows_from_video(pose_model, path: Path, extract_fn):
    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        print(f"  ⚠️  Could not open video: {path.name}")
        return []
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 0
    if total <= 0:
        step = 5
    else:
        step = max(1, total // MAX_FRAMES_PER_VIDEO)

    rows = []
    idx = 0
    read_count = 0
    while True:
        ret, frame = cap.read()
        if not ret:
            break
        if idx % step == 0:
            feats = extract_features_from_frame(pose_model, frame, extract_fn)
            if feats is not None:
                rows.append(feats)
            read_count += 1
            if read_count >= MAX_FRAMES_PER_VIDEO:
                break
        idx += 1
    cap.release()
    print(f"  🎞️  {path.name}: sampled {len(rows)} usable frame(s)")
    return rows


def train_one_exercise(name: str, verbose=True):
    if name not in EXERCISES:
        raise ValueError(f"Unknown exercise '{name}'")
    cfg = get_exercise(name)
    extract_fn = cfg["extract"]
    feature_order = cfg["feature_order"]

    exercise_dir = DATASET_DIR / name
    samples = find_samples(exercise_dir)

    if verbose:
        print(f"\n{'='*60}\nTraining exercise: {name}\n{'='*60}")
        print(f"Found {len(samples)} raw file(s) in {exercise_dir}")

    if len(samples) == 0:
        msg = f"No data found for '{name}' in {exercise_dir}"
        print(f"❌ {msg}")
        return {"exercise": name, "success": False, "error": msg}

    pose_model = create_pose_detector(static_mode=True)

    X_rows, y_labels = [], []
    n_correct_files = n_incorrect_files = 0

    for path, label, is_video in samples:
        if label == "incorrect":
            n_incorrect_files += 1
        else:
            n_correct_files += 1

        rows = rows_from_video(pose_model, path, extract_fn) if is_video \
            else rows_from_image(pose_model, path, extract_fn)

        for feats in rows:
            X_rows.append([feats[f] for f in feature_order])
            y_labels.append(1 if label == "correct" else 0)

    pose_model.close()

    if len(X_rows) < 4:
        msg = (f"Only {len(X_rows)} usable samples extracted for '{name}'. "
               f"Need at least a few correct AND incorrect samples with a "
               f"person clearly visible.")
        print(f"❌ {msg}")
        return {"exercise": name, "success": False, "error": msg}

    X = np.array(X_rows, dtype=float)
    y = np.array(y_labels, dtype=int)

    n_pos, n_neg = int((y == 1).sum()), int((y == 0).sum())
    if n_pos == 0 or n_neg == 0:
        msg = (f"Need BOTH correct and incorrect examples. Got "
               f"{n_pos} correct / {n_neg} incorrect usable samples.")
        print(f"❌ {msg}")
        return {"exercise": name, "success": False, "error": msg}

    # Feature stats (from CORRECT samples only) — used at inference time to
    # generate human-readable coaching tips ("go lower", "straighten arms"...)
    correct_stats = {}
    X_correct = X[y == 1]
    for i, fname in enumerate(feature_order):
        correct_stats[fname] = {
            "mean": float(X_correct[:, i].mean()),
            "std": float(max(X_correct[:, i].std(), 1e-6)),
        }

    scaler = StandardScaler()
    can_split = len(X) >= 8 and min(n_pos, n_neg) >= 2
    if can_split:
        X_train, X_test, y_train, y_test = train_test_split(
            X, y, test_size=0.25, random_state=42, stratify=y
        )
    else:
        X_train, X_test, y_train, y_test = X, X, y, y  # tiny dataset: eval on train

    X_train_scaled = scaler.fit_transform(X_train)
    X_test_scaled = scaler.transform(X_test)

    n_estimators = 100 if len(X_train) >= 20 else 50
    model = RandomForestClassifier(
        n_estimators=n_estimators, random_state=42, max_depth=6
    )
    model.fit(X_train_scaled, y_train)
    preds = model.predict(X_test_scaled)
    accuracy = float(accuracy_score(y_test, preds))

    joblib.dump(model, MODELS_DIR / f"{name}_model.pkl")
    joblib.dump(scaler, MODELS_DIR / f"{name}_scaler.pkl")

    metadata = {
        "exercise": name,
        "display_name": cfg["display_name"],
        "type": cfg["type"],
        "feature_order": feature_order,
        "accuracy": accuracy,
        "n_samples": len(X),
        "n_correct": n_pos,
        "n_incorrect": n_neg,
        "n_correct_files": n_correct_files,
        "n_incorrect_files": n_incorrect_files,
        "correct_feature_stats": correct_stats,
        "trained_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "evaluated_on_holdout": can_split,
    }
    with open(MODELS_DIR / f"{name}_meta.json", "w") as f:
        json.dump(metadata, f, indent=2)

    if verbose:
        print(f"✅ Trained '{name}': accuracy={accuracy:.1%} "
              f"({len(X)} samples: {n_pos} correct / {n_neg} incorrect)")
        print(f"   Saved: models/{name}_model.pkl, {name}_scaler.pkl, {name}_meta.json")

    return {"exercise": name, "success": True, **metadata}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--exercise", help="exercise name, e.g. squat")
    parser.add_argument("--all", action="store_true", help="train every exercise")
    args = parser.parse_args()

    if not args.exercise and not args.all:
        parser.error("Pass --exercise <name> or --all")

    names = list_exercise_names() if args.all else [args.exercise]
    results = [train_one_exercise(name) for name in names]

    print("RESULT_JSON:" + json.dumps(results))


if __name__ == "__main__":
    main()
