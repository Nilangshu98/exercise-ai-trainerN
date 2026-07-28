"""
pose_model.py

Creates a pose detector with ONE simple interface, regardless of which
MediaPipe API is installed:

    detector = create_pose_detector()
    landmarks = detector.process(frame_bgr)   # -> list of 33 landmarks, or None
    detector.close()

Each landmark has .x, .y, .z, .visibility (0..1, normalized image coords).

Why this exists: MediaPipe has two Python APIs for pose estimation:
  - The classic "solutions" API (`mediapipe.solutions.pose`) — what almost
    every tutorial (and the original prototype this app is based on) uses.
    Available on most `pip install mediapipe` setups, Python 3.9-3.11.
  - The newer "Tasks" API (`mediapipe.tasks.python.vision.PoseLandmarker`) —
    what some newer/minimal MediaPipe builds ship instead. Requires
    downloading a small model bundle (.task file) on first use.

This module tries the classic API first (fast, no download) and
transparently falls back to the Tasks API if that's all that's available.
"""

import os
import urllib.request
from pathlib import Path

import cv2
import numpy as np

MODELS_DIR = Path(__file__).resolve().parent.parent / "models"
TASK_MODEL_PATH = MODELS_DIR / "pose_landmarker.task"
TASK_MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/pose_landmarker/"
    "pose_landmarker_lite/float16/latest/pose_landmarker_lite.task"
)


class _Landmark:
    __slots__ = ("x", "y", "z", "visibility")

    def __init__(self, x, y, z, visibility):
        self.x, self.y, self.z, self.visibility = x, y, z, visibility


class _LegacyDetector:
    """Wraps mediapipe.solutions.pose.Pose"""

    def __init__(self, static_mode=True):
        import mediapipe as mp
        self._mp_pose = mp.solutions.pose
        self._model = self._mp_pose.Pose(
            static_image_mode=static_mode,
            min_detection_confidence=0.5,
            min_tracking_confidence=0.5,
        )

    def process(self, frame_bgr):
        image_rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
        results = self._model.process(image_rgb)
        if not results.pose_landmarks:
            return None
        return list(results.pose_landmarks.landmark)

    def close(self):
        self._model.close()


class _TasksDetector:
    """Wraps mediapipe.tasks.python.vision.PoseLandmarker (fallback)."""

    def __init__(self, static_mode=True):
        import mediapipe as mp
        from mediapipe.tasks import python as mp_tasks
        from mediapipe.tasks.python import vision

        self._mp = mp
        self._ensure_model_downloaded()

        base_options = mp_tasks.BaseOptions(model_asset_path=str(TASK_MODEL_PATH))
        running_mode = (
            vision.RunningMode.IMAGE if static_mode else vision.RunningMode.VIDEO
        )
        options = vision.PoseLandmarkerOptions(
            base_options=base_options,
            running_mode=running_mode,
            num_poses=1,
        )
        self._landmarker = vision.PoseLandmarker.create_from_options(options)
        self._static_mode = static_mode
        self._timestamp_ms = 0

    def _ensure_model_downloaded(self):
        if TASK_MODEL_PATH.exists():
            return
        MODELS_DIR.mkdir(exist_ok=True)
        print(f"Downloading pose landmark model to {TASK_MODEL_PATH} ...")
        try:
            urllib.request.urlretrieve(TASK_MODEL_URL, TASK_MODEL_PATH)
        except Exception as e:
            raise RuntimeError(
                "Could not download the MediaPipe pose model (needs internet "
                f"the first time it runs). Original error: {e}"
            )

    def process(self, frame_bgr):
        image_rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
        mp_image = self._mp.Image(image_format=self._mp.ImageFormat.SRGB, data=image_rgb)
        if self._static_mode:
            result = self._landmarker.detect(mp_image)
        else:
            self._timestamp_ms += 33
            result = self._landmarker.detect_for_video(mp_image, self._timestamp_ms)
        if not result.pose_landmarks:
            return None
        pts = result.pose_landmarks[0]
        return [_Landmark(p.x, p.y, p.z, getattr(p, "visibility", 1.0)) for p in pts]

    def close(self):
        self._landmarker.close()


def create_pose_detector(static_mode=True):
    """Returns a detector with .process(frame_bgr) and .close()."""
    try:
        return _LegacyDetector(static_mode=static_mode)
    except Exception as legacy_error:
        try:
            return _TasksDetector(static_mode=static_mode)
        except Exception as tasks_error:
            raise RuntimeError(
                "Could not initialize MediaPipe Pose using either the classic "
                "solutions API or the Tasks API.\n"
                f"  solutions API error: {legacy_error}\n"
                f"  tasks API error: {tasks_error}\n"
                "Try: pip install mediapipe==0.10.14 (Python 3.9-3.11 recommended)"
            )
