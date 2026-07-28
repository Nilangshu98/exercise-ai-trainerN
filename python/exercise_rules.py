"""
exercise_rules.py

Single source of truth for "what defines this exercise". Both the trainer
(train.py) and the live predictor (predictor.py) import EXERCISES from here,
so adding a brand-new exercise to the whole app is a matter of:

  1. Add a folder  dataset/<name>/correct/  and  dataset/<name>/incorrect/
     with some .jpg/.png/.mp4/.avi samples.
  2. Add one entry to EXERCISES below describing which joint angles define
     the pose and how reps/holds should be counted.
  3. Run training (via train.html in the app, or `python train.py --exercise <name>`).

No other code needs to change - the API, frontend exercise list, and live
detection page all read this file (via /api/exercises) to know what
exercises exist.
"""

from pose_utils import calculate_angle, pick_side


def _squat_features(landmarks):
    s = pick_side(landmarks)
    knee_angle = calculate_angle(s["hip"], s["knee"], s["ankle"])
    back_angle = calculate_angle(s["shoulder"], s["hip"], s["knee"])
    return {"knee_angle": knee_angle, "back_angle": back_angle}


def _plank_features(landmarks):
    s = pick_side(landmarks)
    back_angle = calculate_angle(s["shoulder"], s["hip"], s["ankle"])
    return {"back_angle": back_angle}


def _cobra_features(landmarks):
    s = pick_side(landmarks)
    elbow_angle = calculate_angle(s["shoulder"], s["elbow"], s["wrist"])
    shoulder_angle = calculate_angle(s["elbow"], s["shoulder"], s["hip"])
    return {"elbow_angle": elbow_angle, "shoulder_angle": shoulder_angle}


EXERCISES = {
    "squat": {
        "display_name": "Squat",
        "icon": "🏋️",
        "type": "reps",  # counted by repetition
        "extract": _squat_features,
        "feature_order": ["knee_angle", "back_angle"],
        "tips": {
            "knee_angle": {
                "low": "Great depth on that squat!",
                "high": "Go lower! Bend your knees more for full squat depth.",
            },
            "back_angle": {
                "low": "Keep your chest up — you're leaning too far forward.",
                "high": "Good upright chest position.",
            },
        },
        # Rep counting: watch the knee angle cross these thresholds.
        "rep_feature": "knee_angle",
        "rep_down_below": 100,   # angle drops below this => "down" phase
        "rep_up_above": 160,     # angle rises above this => "up" phase (counts 1 rep)
    },
    "plank": {
        "display_name": "Plank",
        "icon": "🧘",
        "type": "hold",  # scored by how long good form is held
        "extract": _plank_features,
        "feature_order": ["back_angle"],
        "tips": {
            "back_angle": {
                "low": "Lift your hips — your back is sagging.",
                "high": "Lower your hips slightly — you're piking up.",
            },
        },
    },
    "cobra": {
        "display_name": "Cobra Stretch",
        "icon": "🐍",
        "type": "hold",
        "extract": _cobra_features,
        "feature_order": ["elbow_angle", "shoulder_angle"],
        "tips": {
            "elbow_angle": {
                "low": "Straighten your arms a bit more.",
                "high": "Good arm extension!",
            },
            "shoulder_angle": {
                "low": "Open your chest more — relax your shoulders down and back.",
                "high": "Great shoulder and chest opening!",
            },
        },
    },

    # --- To add a new exercise, copy this template: ---
    # "pushup": {
    #     "display_name": "Push-up",
    #     "icon": "💪",
    #     "type": "reps",
    #     "extract": lambda lm: {"elbow_angle": ...},
    #     "feature_order": ["elbow_angle"],
    #     "tips": {"elbow_angle": {"low": "...", "high": "..."}},
    #     "rep_feature": "elbow_angle",
    #     "rep_down_below": 90,
    #     "rep_up_above": 160,
    # },
}


def list_exercise_names():
    return list(EXERCISES.keys())


def get_exercise(name):
    if name not in EXERCISES:
        raise KeyError(f"Unknown exercise '{name}'. Known: {list_exercise_names()}")
    return EXERCISES[name]
