# QNX difficulty director

This local-AI slice uses NumPy and OpenCV ML. The model receives normalized
active-order pressure, failed-submission rate, busy-stove count, and round
elapsed time, then returns `easy`, `normal`, or `hectic`.

`train.py` produces a reproducible OpenCV random-forest model from synthetic round states;
it is not a claim of collected player data. Replace the synthetic labels with
observed playtest outcomes after the hackathon.

Build the model once, then deploy this directory to the QNX Pi:

```sh
python train.py
chmod +x difficulty_infer.py
./difficulty_infer.py 0.3 0 0.2 0.5
```

On QNX, install `python3-numpy python3-opencv`, then start the server with `HTN26_DIFFICULTY_INFER` set to the deployed
`difficulty_infer.py` path. It emits one JSON decision per new order. The
director cannot create an invalid recipe or exceed the existing active-order
limit.
