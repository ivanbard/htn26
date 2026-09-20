import hashlib
import json
import threading
import unittest
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from pi.difficulty.contract import bootstrap_label, validate_feature_snapshot
from pi.difficulty.sidecar import create_server, recommendation

ROOT = Path(__file__).resolve().parents[1]


class FakePredictor:
    metadata = {
        "name": "fixture-rtrees",
        "version": "test-1",
        "artifact": "fixture.xml",
    }

    def __init__(self, label="normal"):
        self.label = label
        self.values = None

    def predict(self, values):
        self.values = values
        return self.label


def request_payload(**overrides):
    features = {
        "activeOrderPressure": 0.25,
        "recentFailureRate": 0.0,
        "busyStovePressure": 0.5,
        "roundElapsed": 0.75,
    }
    features.update(overrides)
    return {"schemaVersion": 1, "features": features}


class ContractTests(unittest.TestCase):
    def test_request_is_exactly_four_normalized_features(self):
        values = validate_feature_snapshot(request_payload())
        self.assertEqual(values, [0.25, 0.0, 0.5, 0.75])
        for bad in (
            {**request_payload(), "score": 1000},
            request_payload(activeOrderPressure=1.1),
            request_payload(roundElapsed=True),
            {"schemaVersion": 2, "features": request_payload()["features"]},
        ):
            with self.assertRaises(ValueError):
                validate_feature_snapshot(bad)

    def test_pr22_bootstrap_policy_retains_all_three_classes(self):
        self.assertEqual(bootstrap_label(0.2, 0.5, 0.0, 0.1), 0)
        self.assertEqual(bootstrap_label(0.3, 0.0, 0.2, 0.5), 1)
        self.assertEqual(bootstrap_label(0.2, 0.1, 0.2, 0.9), 2)

    def test_recommendation_is_label_and_metadata_only(self):
        predictor = FakePredictor("hectic")
        result = recommendation(predictor, request_payload())
        self.assertEqual(result["difficulty"], "hectic")
        self.assertEqual(
            set(result),
            {"schemaVersion", "difficulty", "source", "model", "latencyMs"},
        )
        self.assertEqual(set(result["model"]), {"name", "version", "artifact"})
        self.assertEqual(predictor.values, [0.25, 0.0, 0.5, 0.75])
        forbidden = {
            "recipe",
            "gold",
            "deadline",
            "score",
            "layout",
            "inventory",
            "timer",
        }
        self.assertTrue(forbidden.isdisjoint(result))

    def test_pr22_model_artifact_is_retained(self):
        artifact = ROOT / "difficulty.xml"
        digest = hashlib.sha256(artifact.read_bytes()).hexdigest()
        self.assertEqual(
            digest, "ba168304a8b19fac7f4fae9cf81eb069400d1e74cfdd5795cb9d7b11f77ff4e8"
        )
        self.assertIn(b"opencv_ml_rtrees", artifact.read_bytes()[:200])


class HttpTests(unittest.TestCase):
    def setUp(self):
        self.predictor = FakePredictor("easy")
        self.server = create_server("127.0.0.1", 0, self.predictor)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def test_health_and_recommendation_endpoints(self):
        with urlopen(f"{self.base}/healthz", timeout=1) as response:
            health = json.load(response)
        self.assertEqual(health["status"], "ready")

        request = Request(
            f"{self.base}/v1/recommendation",
            data=json.dumps(request_payload()).encode("utf-8"),
            headers={"content-type": "application/json"},
            method="POST",
        )
        with urlopen(request, timeout=1) as response:
            result = json.load(response)
        self.assertEqual(result["difficulty"], "easy")
        self.assertEqual(
            set(result), {"schemaVersion", "difficulty", "source", "model", "latencyMs"}
        )

    def test_http_rejects_unbounded_or_extra_input(self):
        request = Request(
            f"{self.base}/v1/recommendation",
            data=json.dumps(request_payload(score=10)).encode("utf-8"),
            headers={"content-type": "application/json"},
            method="POST",
        )
        with self.assertRaises(HTTPError) as caught:
            urlopen(request, timeout=1)
        self.assertEqual(caught.exception.code, 400)


class OptionalOpenCvSmokeTests(unittest.TestCase):
    def test_artifact_predicts_a_bounded_label_when_opencv_is_installed(self):
        try:
            from pi.difficulty.model import OpenCvDifficultyModel

            model = OpenCvDifficultyModel(ROOT / "difficulty.xml")
        except ModuleNotFoundError as error:
            self.skipTest(f"optional local OpenCV runtime unavailable: {error}")
        self.assertIn(model.predict([0.3, 0.0, 0.2, 0.5]), ("easy", "normal", "hectic"))


if __name__ == "__main__":
    unittest.main()
