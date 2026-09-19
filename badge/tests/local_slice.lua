local world = dofile("badge/tests/harness.lua").new()
local host = world.app("badge/overcooked-host.lua", "00:00:00:00:00:01")
local player = world.app("badge/overcooked-player.lua", "00:00:00:00:00:02")
local serve = world.app("badge/overcooked-serve.lua", "00:00:00:00:00:03")
world.settle()
assert(player.shows("Host connected") and serve.shows("Place plate here"))
assert(host.shows("Players: 1"))
assert(world.packets[1].payload == "OC1|H|0001|P")

-- Invalid NFC is rejected locally; an empty plate is rejected by the host.
local before = #world.packets
world.scan(player, "I:TOM|injected", "bad")
assert(#world.packets == before and player.shows("Not in MVP"))
world.scan(serve, "P:01", "empty")
assert(serve.shows("WRONG DISH") and host.shows("Score: 0"))

world.scan(player, "I:TOM", "tomato")
assert(player.shows("RAW TOMATO"))
assert(world.count("GAME|PICKUP|0002|TOM") == 1)
-- Same physical tag is debounced; a different tomato is rejected with full hands.
before = #world.packets
world.tick(200)
assert(#world.packets == before)
world.scan(player, "I:TOM", "tomato-2")
assert(player.shows("Hands already full"))
world.scan(player, "P:01", "plate-1")
assert(player.shows("NOTHING") and player.shows("Added to Plate 01"))
assert(world.count("GAME|PLATE_ADD|01|TOM") == 1)

-- Drop the first successful submission reply. Retry must reuse its sequence,
-- replay the host's cached reply, and leave both scoring and logs exactly once.
local send = host.transport.send
local dropped = false
host.transport.send = function(payload)
  if not dropped and string.match(payload, "^OC1|U|%d%d%d%d|000000000003|S01$") then
    dropped = true
    return true
  end
  return send(payload)
end
world.scan(serve, "P:01", "delivery-1")
assert(dropped and host.shows("Score: 10") and not serve.shows("ORDER COMPLETE"))
world.tick(800)
world.settle()
assert(serve.shows("ORDER COMPLETE"))
assert(world.count("GAME|SUBMIT|01|OK") == 1)
assert(world.count("GAME|SCORE|10") == 1)
local retries = 0
for _, packet in ipairs(world.packets) do
  assert(#packet.payload <= 44)
  if packet.mac == "00:00:00:00:00:03" and packet.payload == "OC1|V|0003|P:01" then retries = retries + 1 end
end
assert(retries == 2, "submission retry must reuse exact frame")
world.scan(serve, "P:01", "delivery-again")
assert(serve.shows("WRONG DISH") and host.shows("Score: 10"))

-- Independent badge identities cannot steal targeted responses or held items.
local other = world.app("badge/overcooked-player.lua", "00:00:00:00:00:04")
world.settle()
assert(host.shows("Players: 2"))
world.scan(player, "I:TOM", "tomato-3")
assert(player.shows("RAW TOMATO") and other.shows("NOTHING"))
world.scan(other, "P:02", "empty-hand")
assert(other.shows("Nothing to place"))
world.scan(player, "P:02", "plate-2")
world.scan(other, "I:TOM", "tomato-4")
world.scan(other, "P:02", "occupied")
assert(other.shows("Plate already used") and other.shows("RAW TOMATO"))
world.scan(serve, "P:02", "delivery-2")
assert(host.shows("Score: 20") and world.count("GAME|SCORE|20") == 1)

-- A missing host eventually times out; there is no fabricated acknowledgement.
host.env.on_exit()
before = #world.packets
world.scan(other, "P:03", "unreachable")
for _ = 1, 4 do world.tick(800) end
assert(other.shows("Host did not respond"))
assert(#world.packets - before == 4, "retry budget must stay bounded")
assert(not host.transport.send("ping"))
for _, app in ipairs({ player, serve, other }) do
  app.env.on_exit()
  assert(not app.nfc_on and not app.transport.send("ping"))
end

-- Local and hardware adapters honor the same listener/lifecycle contract.
local bus = dofile("badge/local_transport.lua").new()
local a, b = bus.endpoint("AA:00:00:00:00:01"), bus.endpoint("AA:00:00:00:00:02")
a.enable() b.enable()
local got
b.on_recv(function(mac, rssi, payload) got = { mac, rssi, payload } end)
assert(not a.send("") and not a.send(string.rep("x", 45)))
assert(a.send("OC1|H|0001|P") and got[1] == a.mac() and got[3] == "OC1|H|0001|P")
b.disable() got = nil a.send("ping") assert(got == nil)
local radio_calls, callback = 0, nil
local fake_radio = {
  enable = function() radio_calls = radio_calls + 1 return true end,
  on_recv = function(fn) callback = fn end,
  send = function(payload) callback("AA:00:00:00:00:01", -40, payload) return true end,
  mac = a.mac, dropped = function() return 0 end,
  disable = function() radio_calls = radio_calls + 1 end,
}
local factory = dofile("badge/radio_transport.lua")
local blocked = factory.new(fake_radio, false)
assert(not blocked.enable() and not blocked.send("ping") and radio_calls == 0)
local radio = factory.new(fake_radio, true)
assert(radio.enable())
radio.on_recv(function(mac, rssi, payload) got = { mac, rssi, payload } end)
assert(radio.send("OC1|H|0001|P") and got[3] == "OC1|H|0001|P")
radio.disable()
assert(callback == nil and radio_calls == 2 and not radio.send("ping"))

for _, line in ipairs(world.logs) do print(line) end
print("PASS: real Lua NFC -> action -> host -> plate -> submission -> score -> sys.log; retries, rejection, identities, cleanup, adapters")
