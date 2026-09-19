-- Local three-component smoke: self-contained player -> gateway serial stream.
local world = dofile("badge/tests/harness.lua").new()
local gateway = world.app("badge/master/main.lua", "00:00:00:00:01:01")
local player = world.app("badge/slave/main.lua", "00:00:00:00:01:02")

-- Provision the fixed player number before the round; there is no join flow.
player.env.on_button(1, 1) -- A / PRESSED
assert(player.shows("PLAYER 1 SAVED"))

-- Host START owns the compact sequence-tagged lifecycle broadcast.
gateway.env.on_button(3, 1) -- START
world.settle()
assert(player.shows("GAME STARTED"))
assert(world.count("HTN26|HOST|CONTROL|OC1|000001|G|S") == 1)
assert(world.count("HTN26|RX|00:00:00:00:01:02|-40|OC1|000001|E|P1:READY") == 1)

local function scan_with(button, text, uid)
  player.env.on_button(button, 1)
  world.scan(player, text, uid)
  player.env.on_button(button, 2)
  world.tick(600)
end

scan_with(5, "pantry", "pantry-1") -- RIGHT -> bun
assert(player.shows("PICKED UP BUN"))
assert(world.count("HTN26|RX|00:00:00:00:01:02|-40|OC1|000002|E|P1:PU:B") == 1)

-- A second source scan while the hand is full is rejected locally and is not
-- turned into a gateway event.
local before = #world.logs
scan_with(4, "fridge", "fridge-1") -- LEFT -> raw meat, invalid with bun held
assert(player.shows("HAND FULL"))
assert(#world.logs == before)

-- Host end is likewise emitted by the host path, not injected by the smoke test.
gateway.env.on_button(3, 1) -- START is ignored while the round is active
world.tick(120000)
world.settle()
assert(player.shows("GAME ENDED"))
assert(world.count("HTN26|HOST|CONTROL|OC1|000002|G|E") == 1)
assert(player.shows("Plate: NONE") and player.shows("Hand: EMPTY"))

-- Delayed controls cannot reopen the ended round or close a newer one.
assert(gateway.transport.send("OC1|000001|G|S"))
world.settle()
assert(player.shows("GAME ENDED"))
gateway.env.on_button(3, 1) -- begin a fresh host-owned round
world.settle()
assert(player.shows("GAME STARTED"))
assert(gateway.transport.send("OC1|000002|G|E"))
world.settle()
assert(player.shows("GAME STARTED"))

gateway.env.on_exit()
player.env.on_exit()
assert(not gateway.transport.send("ping"))
assert(not player.transport.send("ping"))
print("PASS: fixed player setup/start/end, NFC intent, local rejection, compact gateway forwarding")
