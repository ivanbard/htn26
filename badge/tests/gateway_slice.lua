-- The PR gateway/player path keeps its own documented sequence-first protocol.
local world = dofile("badge/tests/harness.lua").new()
local gateway = world.app("badge/master/main.lua", "00:00:00:00:01:01")
local player = world.app("badge/slave/main.lua", "00:00:00:00:01:02")
local tags = { "ING:TOMATO", "STATION:CHOP1", "STATION:POT1", "PLATE:1" }
local values = { "ING:TOM", "STN:CHOP1", "STN:POT1", "STN:PLATE" }
for index, tag in ipairs(tags) do
  world.scan(player, tag, "tag-" .. index)
  world.tick(300) world.tick(300) world.settle()
  local frame = "HTN26|RX|00:00:00:00:01:02|-40|OC1|" .. index .. "|N|" .. values[index]
  assert(world.count(frame) == 3, "gateway must forward unchanged bounded retries")
end
local before = #world.packets
world.scan(player, "STATION:DELIVERY", "delivery-not-player-owned")
assert(#world.packets == before and player.shows("UNSUPPORTED TAG"))
world.scan(gateway, "P:01", "plate")
assert(world.count("HTN26|PLATE|P:01") == 1)
world.tick(200)
assert(world.count("HTN26|PLATE|P:01") == 1, "gateway NFC debounce")
gateway.env.on_button(2, 1)
assert(world.count("HTN26|HOST|SCAN|3PI|BURGER") == 1)
gateway.env.on_button(2, 1)
assert(world.count("HTN26|HOST|SCAN|3PI|BURGER") == 1, "scan request cooldown")
gateway.env.on_exit() player.env.on_exit()
assert(not gateway.nfc_on and not player.nfc_on)
assert(not player.transport.send("ping"))
print("PASS: PR player NFC -> unchanged OC1 -> gateway sys.log; bounded retries, gateway-owned plates, host scan, cleanup")
