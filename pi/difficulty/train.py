#!/usr/bin/env python3
"""Recreate PR 22's OpenCV model from deterministic synthetic round states."""

from pathlib import Path

if __package__:
    from .contract import bootstrap_label
else:
    import sys

    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from difficulty.contract import bootstrap_label

MODEL_PATH = Path(__file__).with_name("difficulty.xml")


def main():
    import cv2
    import numpy as np

    rng = np.random.default_rng(2026)
    features = rng.random((2400, 4))
    labels = np.array([bootstrap_label(*row) for row in features], dtype=np.int32)
    cv2.setRNGSeed(2026)
    model = cv2.ml.RTrees_create()  # pyright: ignore[reportAttributeAccessIssue]
    model.setMaxDepth(6)
    model.setMinSampleCount(8)
    model.setTermCriteria((cv2.TERM_CRITERIA_MAX_ITER, 80, 0))
    model.train(features.astype(np.float32), cv2.ml.ROW_SAMPLE, labels)
    model.save(str(MODEL_PATH))
    print(MODEL_PATH)


if __name__ == "__main__":
    main()
