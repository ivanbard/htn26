"""Create a reproducible OpenCV model from synthetic burger-round states."""
from pathlib import Path

import cv2
import numpy as np

MODEL_PATH = Path(__file__).with_name("difficulty.xml")


def label(active_orders, failures, busy_stoves, elapsed):
    if failures >= 0.34 or active_orders >= 0.8:
        return 0
    if elapsed >= 0.65 and failures < 0.2 and active_orders < 0.6:
        return 2
    return 1


def main():
    rng = np.random.default_rng(2026)
    features = rng.random((2400, 4))
    labels = np.array([label(*row) for row in features], dtype=np.int32)
    cv2.setRNGSeed(2026)
    model = cv2.ml.RTrees_create()
    model.setMaxDepth(6)
    model.setMinSampleCount(8)
    model.setTermCriteria((cv2.TERM_CRITERIA_MAX_ITER, 80, 0))
    model.train(features.astype(np.float32), cv2.ml.ROW_SAMPLE, labels)
    model.save(str(MODEL_PATH))
    print(MODEL_PATH)


if __name__ == "__main__":
    main()
