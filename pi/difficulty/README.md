# QNX difficulty sidecar

`pi/difficulty` is an optional, local advisory service. The captain's laptop
remains the authoritative HTN26 server and UI. The sidecar receives four
normalized numbers and returns one bounded label: `easy`, `normal`, or
`hectic`. It never owns or returns recipes, gold, deadlines, score, room layout,
inventory, submissions, badge state, or timer values.

The room-layout/OpenAI provider remains a separate laptop-server endpoint. Do
not route room photographs or floorplan requests through this service.

## HTTP contract v1

The service defaults to `127.0.0.1:8790`. A QNX Pi intended to serve a trusted
local network must explicitly bind an appropriate interface. There is no public
internet authentication layer.

`POST /v1/recommendation` requires `content-type: application/json` and a body
no larger than 4096 bytes. The object and feature names are exact; all features
are finite numbers normalized to `[0, 1]`.

```json
{
  "schemaVersion": 1,
  "features": {
    "activeOrderPressure": 0.33,
    "recentFailureRate": 0.0,
    "busyStovePressure": 0.5,
    "roundElapsed": 0.72
  }
}
```

- `activeOrderPressure`: active orders divided by the laptop's configured cap.
- `recentFailureRate`: failed submissions among at most the latest six.
- `busyStovePressure`: non-idle stoves divided by two.
- `roundElapsed`: elapsed authoritative round time divided by round length.

A successful response has exactly these fields:

```json
{
  "schemaVersion": 1,
  "difficulty": "hectic",
  "source": "local-opencv-rtrees",
  "model": {
    "name": "htn26-difficulty-rtrees",
    "version": "pr22-bootstrap-1",
    "artifact": "difficulty.xml"
  },
  "latencyMs": 3.41
}
```

`difficulty` is the only recommendation. Extra response fields, a different
schema version, invalid metadata, an oversized body, or any label outside
`easy|normal|hectic` cause the laptop adapter to discard the response.

`GET /healthz` returns HTTP 200 with `status: "ready"`, schema/source, and model
metadata after the artifact has loaded. An absent dependency or invalid model
causes startup to fail before the listener opens. Unknown paths return 404;
invalid requests return 400/413/415 and inference failures return 503.

## Model and runtime

The selectively retained PR 22 model is the OpenCV ML random forest at
[`difficulty.xml`](difficulty.xml). `train.py` preserves its reproducible
training concept: NumPy seed 2026, 2,400 synthetic normalized states, OpenCV
`cv2.ml.RTrees`, max depth 6, minimum sample count 8, and at most 80 trees.
Synthetic labels intentionally express a starter policy, not measured player
fun: `easy` when failure rate is at least 0.34 or order pressure is at least
0.8; `hectic` after 0.65 round elapsed only when failure rate is below 0.2 and
order pressure is below 0.6; `normal` otherwise. Busy-stove pressure remains a
model feature even though this starter labeling rule does not explicitly branch
on it. Replace synthetic labels with versioned playtest outcomes later without
broadening the HTTP response.

The artifact's SHA-256 in this revision is
`ba168304a8b19fac7f4fae9cf81eb069400d1e74cfdd5795cb9d7b11f77ff4e8`.
The default artifact path is next to `sidecar.py`; override it with
`HTN26_DIFFICULTY_MODEL` or `--model`.

PR 22 reported an on-device run on `qnxpi72` (QNX 8.0 / Raspberry Pi 5) with
QNX packages `python3-numpy` 2.4.1-r0 and `python3-opencv` 4.12.0-r1, including
OpenCV ML. Those observations motivate the runtime assumptions, but this
branch has not repeated QNX validation. Confirm the packages against the target
QNX repository/image before deployment. The service also requires Python 3's
`http.server`, `threading`, and `json` standard-library modules.

Example QNX deployment path and launch:

```sh
cd /data/home/qnxuser/htn26
python3 pi/difficulty/sidecar.py \
  --host 0.0.0.0 \
  --port 8790 \
  --model /data/home/qnxuser/htn26/pi/difficulty/difficulty.xml
```

Environment equivalents are `HTN26_DIFFICULTY_BIND_HOST`,
`HTN26_DIFFICULTY_PORT`, and `HTN26_DIFFICULTY_MODEL`.

Representative checks from another trusted local machine:

```sh
curl -fsS http://QNX_PI_ADDRESS:8790/healthz
curl -fsS -X POST http://QNX_PI_ADDRESS:8790/v1/recommendation \
  -H 'content-type: application/json' \
  -d '{"schemaVersion":1,"features":{"activeOrderPressure":0.33,"recentFailureRate":0,"busyStovePressure":0.5,"roundElapsed":0.72}}'
```

## Laptop adapter and fallback

The laptop adapter is disabled by default. Enable it only when the sidecar is
reachable:

```sh
HTN26_DIFFICULTY_SIDECAR_URL=http://QNX_PI_ADDRESS:8790 \
HTN26_DIFFICULTY_SIDECAR_TIMEOUT_MS=200 \
node pi/server/server.mjs
```

The server issues a recommendation request asynchronously after creating an
order. It never waits for the request in a game transition. A valid returned
label may guide the *next* order: laptop code maps `easy` to its plain recipe,
`normal` to its alternating one-topping recipes, and `hectic` to its two-topping
recipe. Thus the laptop, not the response, chooses from the existing recipe
catalog and continues to enforce order caps and every game rule.

No configured URL, connection failure, HTTP error, 200 ms timeout, malformed
JSON, invalid/extra output, or a late response leaves no usable label. The
laptop then follows its pre-existing deterministic order sequence. Responses
from ended/reset rounds are ignored. The sidecar cannot pause order creation or
mutate the authoritative snapshot.

This supersedes PR 22's direct synchronous `execFileSync` bridge and its old
`pi/server` integration. The useful model artifact, synthetic training policy,
and three-label concept moved behind this isolated HTTP boundary. A future
migration may retrain/version the artifact or replace the model implementation;
it must preserve the label-only contract unless laptop authority is separately
redesigned.

## Host tests and optional smoke

From the repository root:

```sh
python3 -m unittest discover -s pi/difficulty/test -v
node --test pi/server/test/*.test.mjs
```

The protocol and artifact-integrity tests need neither QNX nor OpenCV. The real
model load/prediction test is skipped when local OpenCV/NumPy are absent. With
the packages from `requirements.txt` available, exercise the real artifact and an ephemeral
loopback HTTP server:

```sh
python3 pi/difficulty/smoke.py
```

For this revision's validation, the real OpenCV model smoke was not run because
`cv2` was unavailable. No QNX hardware validation was performed or claimed.

These are laptop-hosted checks. They do not claim QNX, physical badge,
phone-camera, or deployed-network validation.
