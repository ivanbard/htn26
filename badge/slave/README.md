# HTN26 Player Badge

This directory contains the first player-side Hacker Badge app for Overcooked
IRL. Upload `manifest.cfg`, `main.lua`, and the shared `badge/transport.lua`
and `badge/radio_transport.lua` modules together. Hardware radio is disabled
pending the firmware fix. See [local testing](../LOCAL_TESTING.md) for the
executable mock transport and the documented badge API boundary.

## Local tag contract

The app accepts these NFC NDEF Text values:

- `ING:TOMATO`
- `STATION:CHOP1`
- `STATION:POT1`
- `PLATE:1`

A valid read emits an NFC event as
`OC1|<sequence>|N|<canonical-value>`, mapping the player tag text to
`ING:TOM`, `STN:CHOP1`, `STN:POT1`, or `STN:PLATE`. Values are
printable ASCII, and the complete payload is limited to the documented 44-byte
restricted-radio limit. Repeated reads of the same card UID are ignored until
a bounded post-capture re-arm schedule calls `badge.nfc.clear()`; the same UID
remains suppressed while it is still present and is accepted again after
removal. **A** also calls `clear()` for manual re-arm. Invalid, unsupported,
and oversized text is reported locally and is not transmitted.

Each accepted event reserves one monotonically increasing sequence number;
the current number is saved in the app's `seq` store key so reopening does not
reuse it. The bounded transmitter makes at most three attempts with the exact
same payload and sequence number. `badge.radio.send()` means queued only; the screen and
LEDs deliberately say **locally captured**, never server-confirmed. A full
four-event pending queue reports a local drop rather than growing without
bound.

The intended player flow is tomato -> chop station -> pot -> plate. Delivery is
owned by the stationary gateway badge: bring the tagged plate to that badge;
this player app does not pretend to confirm delivery.

## Checks

Run the host-side protocol tests from the repository root:

```text
python -m pip install --target .tools/python lupa==2.8
python -m unittest discover -s badge/slave/tests -p 'test_*.py'
python badge/run_local.py
```

The app has not been verified on a physical Hacker Badge in this worktree.
Hardware NFC presence, radio range/queueing, LED appearance, and firmware
compatibility still need an IDE upload and physical-badge run.
