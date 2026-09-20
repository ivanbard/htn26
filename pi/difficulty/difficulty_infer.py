#!/usr/bin/env python3
"""Run one local difficulty prediction and write a small JSON response."""
import json
import os
import sys
import time
from pathlib import Path

import cv2
import numpy as np


def main():
    if len(sys.argv) != 5:
        raise SystemExit("usage: difficulty_infer.py active_orders failure_rate busy_stoves elapsed")
    values = np.asarray([float(value) for value in sys.argv[1:]], dtype=np.float64)
    if not np.isfinite(values).all() or ((values < 0) | (values > 1)).any():
        raise SystemExit("all features must be finite values from 0 to 1")
    path = Path(os.environ.get("HTN26_DIFFICULTY_MODEL", Path(__file__).with_name("difficulty.xml")))
    started = time.monotonic()
    model = cv2.ml.RTrees_load(str(path))
    _, prediction = model.predict(values.reshape(1, -1).astype(np.float32))
    level = ("easy", "normal", "hectic")[int(prediction[0, 0])]
    print(json.dumps({"level": level, "latencyMs": round((time.monotonic() - started) * 1000, 2)}))


if __name__ == "__main__":
    main()
