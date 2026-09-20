"""OpenCV RTrees predictor used by the local QNX difficulty sidecar."""

import threading
from pathlib import Path

from .contract import DIFFICULTIES

MODEL_NAME = "htn26-difficulty-rtrees"
MODEL_VERSION = "pr22-bootstrap-1"


class OpenCvDifficultyModel:
    def __init__(self, artifact_path):
        # Keep imports here so protocol tests can run without optional model packages.
        import cv2
        import numpy as np

        self._cv2 = cv2
        self._np = np
        self.artifact_path = Path(artifact_path).resolve()
        if not self.artifact_path.is_file():
            raise FileNotFoundError(f"model artifact not found: {self.artifact_path}")
        self._model = cv2.ml.RTrees_load(str(self.artifact_path))
        if self._model is None or self._model.empty():
            raise RuntimeError(f"could not load OpenCV model: {self.artifact_path}")
        self._lock = threading.Lock()

    @property
    def metadata(self):
        return {
            "name": MODEL_NAME,
            "version": MODEL_VERSION,
            "artifact": self.artifact_path.name,
        }

    def predict(self, values):
        sample = self._np.asarray(values, dtype=self._np.float32).reshape(1, -1)
        with self._lock:
            _, prediction = self._model.predict(sample)
        index = int(prediction[0, 0])
        if index < 0 or index >= len(DIFFICULTIES):
            raise RuntimeError("model returned an out-of-range class")
        return DIFFICULTIES[index]
