# HTN26 Player Badge

This directory contains the first player-side Hacker Badge app for Overcooked
IRL. `manifest.cfg` and `main.lua` are self-contained and use only the API in
`badge/badge-app-guide.md`.

## Local tag contract

The app accepts these NFC NDEF Text values:

- `ING:TOMATO`
- `STATION:CHOP1`
- `STATION:POT1`
- `PLATE:1`

A valid read emits an NFC event as
`OC1|<sequence>|N|<tag-value>`. Values are printable ASCII, and the complete
payload is limited to the documented 44-byte restricted-radio limit. Repeated
reads of the same card UID are ignored until the card is removed or **A** is
pressed to re-arm the reader. Invalid, unsupported, and oversized text is
reported locally and is not transmitted.

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
python3 -m unittest discover -s badge/slave/tests -p 'test_*.py'
```

The app has not been verified on a physical Hacker Badge in this worktree.
Hardware NFC presence, radio range/queueing, LED appearance, and firmware
compatibility still need an IDE upload and physical-badge run.
