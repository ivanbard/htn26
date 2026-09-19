# HTN26 fixed player badge

`badge/slave/main.lua` is the current self-contained player app. It uses only
APIs in [`../badge-app-guide.md`](../badge-app-guide.md); it has no `require`,
network, camera, Pi-response, or multi-Pi dependency.

## Install files

The exact badge app files are:

```text
badge/slave/manifest.cfg
badge/slave/main.lua
```

For the IDE's two-file workspace, replace `manifest.cfg` and `main.lua` with
those files and push both. No transport module, test file, image, or host app
is part of the player upload. On an IDE with **Import app**, use the same
manifest values as the header shown in `manifest.cfg` and paste the complete
main file after the guide's manifest delimiter, then choose **Replace editor
files** and **Push**. The app is otherwise self-contained.

Before a round, each badge is provisioned once: **LEFT/RIGHT** chooses player
1, 2, or 3 and **A** saves it. The stored number is fixed for the session.
There are exactly three accepted player numbers and no join or late-join
operation. While inactive, **START** reopens this setup screen if a badge must
be reassigned; the new number is stored only when **A** saves it.

## Controls and local rules

The host/gateway must broadcast the compact start and end controls below. A
player ignores station input before start. Start resets all local state; end
sets the badge inactive and discards the hand, plate, chopping progress, and
stoves.

- `pantry` + **RIGHT**: pick up a bun; + **LEFT**: pick up lettuce.
- `fridge` + **RIGHT**: pick up raw cheese; + **LEFT**: pick up raw meat.
- `pantry` + **DOWN**: take an empty plate, or put the held platable item on a
  new plate. A plate accepts bun, cooked meat, sliced lettuce, and sliced
  cheese exactly once each. Raw food and duplicates are rejected.
- With a plate held, the valid directional pantry/fridge scan adds the selected
  platable item; raw selections are rejected.
- Hold **A** while scanning `cutting board` to cut raw meat, lettuce, or cheese.
  The six LED steps take three seconds. Releasing **A** first restores the raw
  item and broadcasts a failed cut.
- Hold **LEFT** or **RIGHT** while scanning `stove` to select the left or right
  stove. Cut meat goes onto an empty stove. An empty hand can take cooked meat
  after 15 seconds; the done period is 2 seconds, the warning period flashes
  for 3 seconds, and then the meat is burnt. Burnt meat must be picked up and
  dropped.
- Hold **B** and shake to drop the held item or plate.
- A supported `badge.sensor.tap()` starts plate/item transfer while both badges
  are tapped. The app also accepts the documented accelerometer fallback: hold
  **A** and bump/shake when not holding a plate. Both participating badges must
  be in the short tap window. A plate merges a platable item, two plates swap,
  and two non-plate hands swap; raw/non-platable items never duplicate onto a
  plate.
- Hold **A** and shake while holding a plate to submit. The submitting plate is
  consumed immediately. Every fixed player broadcasts either `READY` or
  `SUB:<BMLC>` in the 0.5-second window; when all three are observed, every
  badge discards any remaining held item/plate. The app never asks the Pi for an
  order or response, so it only reports the local submission transition.

Invalid button/station combinations show `UNKNOWN BUTTON COMBO` in red and
are not sent. The screen always labels feedback as local capture; a successful
`badge.radio.send()` means queued, not delivered.

## Radio and lifecycle contract

Player events use the compact, sequence-tagged form:

```text
OC1|000042|E|P2:PU:B
OC1|000043|E|P2:CH:D:M
OC1|000044|E|P2:SUB:BMLC
```

The sequence is persistent per badge and increases for every event. The
player number and action are included so the stationary gateway can forward
the event stream unchanged to the single Pi. All payloads are bounded to the
documented 44-byte radio limit. Duplicate peer sequences are ignored locally.
The player app does not implement acknowledgements or pretend to receive Pi
responses.

The gateway's fixed-session control broadcasts are:

```text
OC1|000001|G|S
OC1|000002|G|E
```

`START` and `END` are accepted as the long aliases for `S` and `E`. The host
must send these controls at the beginning/end of the same three-player round;
players do not discover or enroll themselves over radio.

## Host-side validation and hardware limits

Run the focused production-helper tests from the repository root:

```text
python -m pip install --target .tools/python lupa==2.8
python -m unittest discover -s badge/slave/tests -p 'test_*.py' -v
```

The tests cover all four NFC choices and invalid combinations, plate assembly,
duplicate prevention, six-step chopping and early release, cooking/done/warning/
burnt transitions, tap-transfer merge/swap rules, compact sequence packets,
fixed three-player readiness, and state discard. They execute helpers from the
production Lua file rather than a second protocol model.

Host tests cannot validate NFC field coupling, tap or shake thresholds, BLE
radio range/loss/queueing, LED appearance, cooking timing on real hardware, or
USB gateway forwarding. A physical badge run requires the Badge IDE: connect
with a data cable, push exactly `manifest.cfg` and `main.lua`, then open the
player app on each of three badges. Physical validation remains pending until
that upload and run are performed.
