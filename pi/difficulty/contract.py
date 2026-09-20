"""Version 1 wire contract and bootstrap policy for the difficulty sidecar."""

import math

SCHEMA_VERSION = 1
DIFFICULTIES = ("easy", "normal", "hectic")
FEATURE_NAMES = (
    "activeOrderPressure",
    "recentFailureRate",
    "busyStovePressure",
    "roundElapsed",
)


def validate_feature_snapshot(payload):
    """Return the four features in model order or raise ValueError."""
    if not isinstance(payload, dict) or set(payload) != {"schemaVersion", "features"}:
        raise ValueError("request must contain only schemaVersion and features")
    if payload["schemaVersion"] != SCHEMA_VERSION:
        raise ValueError("unsupported schemaVersion")
    features = payload["features"]
    if not isinstance(features, dict) or set(features) != set(FEATURE_NAMES):
        raise ValueError("features must contain exactly the v1 normalized feature set")

    values = []
    for name in FEATURE_NAMES:
        value = features[name]
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError(f"{name} must be a number")
        number = float(value)
        if not math.isfinite(number) or number < 0 or number > 1:
            raise ValueError(f"{name} must be finite and between 0 and 1")
        values.append(number)
    return values


def bootstrap_label(active_orders, failures, busy_stoves, elapsed):
    """PR 22's transparent synthetic labeling policy, retained for retraining."""
    del busy_stoves  # Present in the model input even though the starter policy does not branch on it.
    if failures >= 0.34 or active_orders >= 0.8:
        return 0
    if elapsed >= 0.65 and failures < 0.2 and active_orders < 0.6:
        return 2
    return 1
