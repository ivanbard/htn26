#!/usr/bin/env python3
"""Local, label-only HTTP sidecar for the HTN26 OpenCV difficulty model."""

import argparse
import json
import os
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

if __package__:
    from .contract import DIFFICULTIES, SCHEMA_VERSION, validate_feature_snapshot
else:  # Allow `python3 pi/difficulty/sidecar.py`.
    import sys
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from difficulty.contract import DIFFICULTIES, SCHEMA_VERSION, validate_feature_snapshot

MAX_REQUEST_BYTES = 4096


def recommendation(predictor, payload):
    values = validate_feature_snapshot(payload)
    started = time.monotonic()
    difficulty = predictor.predict(values)
    latency_ms = round((time.monotonic() - started) * 1000, 2)
    if difficulty not in DIFFICULTIES:
        raise RuntimeError("model returned an invalid difficulty")
    return {
        "schemaVersion": SCHEMA_VERSION,
        "difficulty": difficulty,
        "source": "local-opencv-rtrees",
        "model": predictor.metadata,
        "latencyMs": latency_ms,
    }


def handler_for(predictor):
    class DifficultyHandler(BaseHTTPRequestHandler):
        server_version = "HTN26Difficulty/1"

        def _json(self, status, payload):
            body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.send_header("cache-control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path != "/healthz":
                self._json(404, {"status": "not-found"})
                return
            self._json(200, {
                "status": "ready",
                "schemaVersion": SCHEMA_VERSION,
                "source": "local-opencv-rtrees",
                "model": predictor.metadata,
            })

        def do_POST(self):
            if self.path != "/v1/recommendation":
                self._json(404, {"status": "not-found"})
                return
            if self.headers.get_content_type() != "application/json":
                self._json(415, {"status": "invalid-request", "error": "content-type must be application/json"})
                return
            try:
                length = int(self.headers.get("content-length", ""))
            except ValueError:
                length = -1
            if length < 0 or length > MAX_REQUEST_BYTES:
                self._json(413, {"status": "invalid-request", "error": "request body is missing or too large"})
                return
            try:
                payload = json.loads(self.rfile.read(length))
                response = recommendation(predictor, payload)
            except (json.JSONDecodeError, UnicodeDecodeError, ValueError) as error:
                self._json(400, {"status": "invalid-request", "error": str(error)})
                return
            except Exception:
                self._json(503, {"status": "unavailable", "error": "model inference failed"})
                return
            self._json(200, response)

        def log_message(self, message, *args):
            print(f"difficulty-sidecar: {self.address_string()} - {message % args}")

    return DifficultyHandler


def create_server(host, port, predictor):
    return ThreadingHTTPServer((host, port), handler_for(predictor))


def parse_args():
    directory = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(description="HTN26 QNX difficulty sidecar")
    parser.add_argument("--host", default=os.environ.get("HTN26_DIFFICULTY_BIND_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("HTN26_DIFFICULTY_PORT", "8790")))
    parser.add_argument("--model", default=os.environ.get("HTN26_DIFFICULTY_MODEL", str(directory / "difficulty.xml")))
    return parser.parse_args()


def main():
    args = parse_args()
    if __package__:
        from .model import OpenCvDifficultyModel
    else:
        from difficulty.model import OpenCvDifficultyModel
    predictor = OpenCvDifficultyModel(args.model)
    server = create_server(args.host, args.port, predictor)
    print(f"HTN26 difficulty sidecar listening on http://{args.host}:{server.server_port}")
    print(f"model: {predictor.metadata['name']} {predictor.metadata['version']} ({predictor.artifact_path})")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
