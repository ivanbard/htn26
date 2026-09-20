#!/usr/bin/env python3
"""Start the real model on an ephemeral loopback port and make one HTTP request."""

import json
import threading
from pathlib import Path
from urllib.request import Request, urlopen

if __package__:
    from .model import OpenCvDifficultyModel
    from .sidecar import create_server
else:
    import sys
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from difficulty.model import OpenCvDifficultyModel
    from difficulty.sidecar import create_server


def main():
    model = OpenCvDifficultyModel(Path(__file__).with_name("difficulty.xml"))
    server = create_server("127.0.0.1", 0, model)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    request = Request(
        f"http://127.0.0.1:{server.server_port}/v1/recommendation",
        data=json.dumps({
            "schemaVersion": 1,
            "features": {
                "activeOrderPressure": 0.3,
                "recentFailureRate": 0.0,
                "busyStovePressure": 0.2,
                "roundElapsed": 0.5,
            },
        }).encode("utf-8"),
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        with urlopen(request, timeout=2) as response:
            payload = json.load(response)
        if payload.get("difficulty") not in ("easy", "normal", "hectic"):
            raise RuntimeError("smoke response did not contain a bounded label")
        print(json.dumps(payload, indent=2, sort_keys=True))
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


if __name__ == "__main__":
    main()
