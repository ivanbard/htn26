# HTN26 fixed player badge

`badge/slave/main.lua` is the self-contained rollback-only Lua player profile.
It uses only APIs in [`../badge-app-guide.md`](../badge-app-guide.md); it has no
`require`, network, camera, or server-response dependency.

## Supported deployment profiles

The supplied player also reproduces a Lua allocation failure (`used 40497 /
limit 49152, peak 42713`). The production/live deployment is therefore the
pinned native factory extension in [`../native/README.md`](../native/README.md) on all
three players and the host. Open **Overcooked**, press A, choose one unique fixed
number 1–3 with LEFT/RIGHT, and press A again; native radio and NFC start only
after confirmation.

This Lua file remains the explicit compatibility/rollback profile for stock
firmware and is not replaced or deleted. Rollback is whole-fleet: use the Lua
host and all three Lua players together. A mixed round cannot work because Lua
`badge.radio` adds/filters a private `LUA1` carrier prefix while native mode uses
the recovered stock HAL directly. Native flashing, backup, factory-only write,
rollback, and remaining physical gates are owned by the native guide.

The gameplay controls and compact OC2 application payloads below are shared by
both profiles. Native event sequences are six digits and monotonic for one app
boot, randomized at boot; unlike the Lua store-backed sequence, they are not
persisted across a reboot. Starting a fresh round resets gateway/laptop-server
session state.

## Lua rollback install files

During native rollout, preserve the badge's original full-device backup and
complete the native guide's read-only security inspection before using the IDE
to update LittleFS. Install and verify the OC2 rollback app only after that
gate and before the factory-only native write.

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
There are three accepted player numbers and no join or late-join
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
  dropped. The `ST:<side>:P` broadcast is the shared start signal: every player
  badge records its receipt time and advances its own copy without asking the
  host, while the gateway forwards the same event to the authoritative server/UI.
- Hold **B** and shake to drop the held item or plate.
- A supported `badge.sensor.tap()` starts plate/item transfer while both badges
  are tapped. The app also accepts the documented accelerometer fallback: hold
  **A** and bump/shake when not holding a plate. Both participating badges must
  be in the short tap window. A plate merges a platable item, two plates swap,
  and two non-plate hands swap; raw/non-platable items never duplicate onto a
  plate.
- Hold **A** and shake while holding a plate to submit. The submitting plate is
  consumed immediately. Every fixed player broadcasts either `READY` or
  `SUB:<BMLC>` in the 0.5-second window; when all active players are observed, every
  badge discards any remaining held item/plate. The app never asks the laptop
  server for an order or response, so it only reports the local submission transition.

Invalid button/station combinations show `UNKNOWN BUTTON COMBO` in red and
are not sent. The screen always labels feedback as local capture; a successful
`badge.radio.send()` means queued, not delivered.

## Radio and lifecycle contract

Player events use the compact, sequence-tagged form:

```text
OC2|000042|E|P2:PU:B
OC2|000043|E|P2:CH:D:D
OC2|000044|E|P2:SUB:BMLC
```

Hand snapshots use distinct meat codes: `HD` is chopped meat ready for a stove,
while `HM` is cooked meat ready for a plate.

The sequence is persistent per badge and increases for every event. The
player number and action are included so the stationary gateway can forward
the event stream unchanged to the production laptop server. All payloads are bounded to the
documented 44-byte radio limit. Duplicate peer sequences are ignored locally.
The player app does not implement acknowledgements or pretend to receive server
responses.

The gateway's fixed-session control broadcasts are:

```text
OC2|000001|G|S|2
OC2|000002|G|E|2
```

`START` and `END` are accepted as the long aliases for `S` and `E`. The host
must send these controls at the beginning/end of the same one-to-three-player round;
players do not discover or enroll themselves over radio.

## Host-side validation and hardware limits

Run the focused production-helper tests from the repository root:

```text
python -m pip install --target .tools/python lupa==2.8
python -m unittest discover -s badge/slave/tests -p 'test_*.py' -v
```

The tests cover all four NFC choices and invalid combinations, plate assembly,
duplicate prevention, six-step chopping and early release, cooking/done/warning/
burnt transitions, peer cooking-clock replication, tap-transfer merge/swap
rules, compact sequence packets,
active-player readiness, and state discard. They execute helpers from the
production Lua file rather than a second protocol model.

Host tests cannot validate NFC field coupling, tap or shake thresholds, BLE
radio range/loss/queueing, LED appearance, cooking timing on real hardware, or
USB gateway forwarding. The Lua profile requires the Badge IDE and exactly
`manifest.cfg` plus `main.lua`. The native guide owns the production hardware boundary. The captain reports the
native binary working except that physical two-badge bumping remains unverified;
neither offline suite proves bump behavior or the generated-icon display on
hardware.
