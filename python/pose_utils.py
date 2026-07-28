"""
pose_utils.py
Shared low-level helpers for working with MediaPipe Pose landmarks.
Used by both train.py (offline training on images/videos) and
predictor.py (live real-time inference).

NOTE: deliberately does NOT import `mediapipe.solutions` at module level.
MediaPipe's Python "solutions" API (the classic mp.solutions.pose used in
most tutorials) is only shipped on some platform/Python combinations; a few
environments only ship the newer Tasks API. To keep this module portable we
work with plain landmark indices (stable across every MediaPipe version)
instead of the mp_pose.PoseLandmark enum. The actual pose-detector object is
created in pose_model.py, which picks whichever API is available.
"""

import numpy as np

# Video/image extensions we know how to read during training
VIDEO_EXTENSIONS = {".mp4", ".avi", ".mov", ".mkv", ".webm"}
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".bmp"}

# Stable landmark indices (same in every MediaPipe Pose API version)
LEFT_SHOULDER, RIGHT_SHOULDER = 11, 12
LEFT_ELBOW, RIGHT_ELBOW = 13, 14
LEFT_WRIST, RIGHT_WRIST = 15, 16
LEFT_HIP, RIGHT_HIP = 23, 24
LEFT_KNEE, RIGHT_KNEE = 25, 26
LEFT_ANKLE, RIGHT_ANKLE = 27, 28


def calculate_angle(a, b, c):
    """Angle (degrees) at point b, formed by points a-b-c. Uses x,y only."""
    a, b, c = np.array(a[:2], dtype=float), np.array(b[:2], dtype=float), np.array(c[:2], dtype=float)
    radians = np.arctan2(c[1] - b[1], c[0] - b[0]) - np.arctan2(a[1] - b[1], a[0] - b[0])
    angle = np.abs(radians * 180.0 / np.pi)
    if angle > 180.0:
        angle = 360 - angle
    return float(angle)


def _xy(landmarks, idx):
    lm = landmarks[idx]
    # works for both a MediaPipe NormalizedLandmark object (has .x/.y/.z/.visibility)
    # and a plain dict {"x":..,"y":..,"z":..,"visibility":..} (used by tests / the
    # frontend replaying landmarks it already has)
    if isinstance(lm, dict):
        return [lm["x"], lm["y"], lm.get("z", 0.0)]
    return [lm.x, lm.y, lm.z]


def _vis(landmarks, idx):
    lm = landmarks[idx]
    if isinstance(lm, dict):
        return lm.get("visibility", 1.0)
    return lm.visibility


def pick_side(landmarks):
    """
    Decide whether the left or right side of the body is more visible to
    the camera, and return a dict of the key joints for that side.
    """
    left_vis = _vis(landmarks, LEFT_SHOULDER)
    right_vis = _vis(landmarks, RIGHT_SHOULDER)
    use_left = left_vis >= right_vis
    idx = {
        "shoulder": LEFT_SHOULDER if use_left else RIGHT_SHOULDER,
        "elbow": LEFT_ELBOW if use_left else RIGHT_ELBOW,
        "wrist": LEFT_WRIST if use_left else RIGHT_WRIST,
        "hip": LEFT_HIP if use_left else RIGHT_HIP,
        "knee": LEFT_KNEE if use_left else RIGHT_KNEE,
        "ankle": LEFT_ANKLE if use_left else RIGHT_ANKLE,
    }
    return {
        "side": "left" if use_left else "right",
        **{name: _xy(landmarks, i) for name, i in idx.items()},
    }


def landmarks_to_list(landmarks):
    """Flatten all 33 MediaPipe landmarks into plain dicts (for sending to
    the frontend so it can draw the skeleton on a canvas)."""
    out = []
    for lm in landmarks:
        if isinstance(lm, dict):
            out.append(lm)
        else:
            out.append({"x": lm.x, "y": lm.y, "z": lm.z, "visibility": lm.visibility})
    return out
