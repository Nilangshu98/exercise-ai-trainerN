"""Prints exercise config as JSON so the Node backend can read the same
single source of truth defined in exercise_rules.py, without duplicating
that list in JavaScript."""
import json
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from exercise_rules import EXERCISES

out = {}
for name, cfg in EXERCISES.items():
    entry = {
        "display_name": cfg["display_name"],
        "icon": cfg["icon"],
        "type": cfg["type"],
        "feature_order": cfg["feature_order"],
    }
    if cfg["type"] == "reps":
        entry["rep_feature"] = cfg["rep_feature"]
        entry["rep_down_below"] = cfg["rep_down_below"]
        entry["rep_up_above"] = cfg["rep_up_above"]
    out[name] = entry

print(json.dumps(out))
