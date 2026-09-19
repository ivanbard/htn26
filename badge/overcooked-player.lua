--[==[badge-app
slug=overcooked_player
name=Overcooked Player
icon=PLYR
api=2
heap_kb=48
wake_lock=1
]==]

local transport = require("transport")

local seq = badge.store.get_int("seq", 0)
local radio, nfc, online = false, false, false
local title, info, pending, next_scan, clear_at, last_uid, last_uid_at
local inbox, held = {}, nil
local fx, fx_end, led_at, led_step = "", 0, 0, 0

local function mac12(value)
  return (string.gsub(value or "", ":", ""))
end

local function show(last)
  title:set_text("PLAYER  Host: " .. (online and "ONLINE" or "SEARCHING"))
  info:set_text("Holding:\n" .. (held or "NOTHING") .. "\n\n" .. (last or "Waiting"))
end

local function effect(name, duration)
  fx, fx_end, led_step, led_at = name, badge.sys.ms() + duration, 0, 0
end

local function send(kind, value)
  if pending then return end
  seq = (seq + 1) % 10000
  badge.store.set_int("seq", seq)
  local number = string.format("%04d", seq)
  local payload = "OC1|" .. kind .. "|" .. number .. "|" .. value
  pending = { number, payload, 1, badge.sys.ms() + 800 }
  transport.send(payload)
  fx, fx_end = "wait", 0
end

local function start()
  radio = transport.enable()
  if not radio then
    title:set_text("TRANSPORT UNAVAILABLE")
    info:set_text("A: RETRY\nHOME: EXIT")
    effect("bad", 1000)
    return
  end
  transport.on_recv(function(mac, rssi, payload)
    if #inbox < 4 and string.sub(payload or "", 1, 4) == "OC1|" then inbox[#inbox + 1] = payload end
  end)
  nfc = badge.nfc.enable()
  if nfc then badge.nfc.clear() end
  show(nfc and "Joining host" or "NFC unavailable")
  send("H", "P")
end

local function receive(payload)
  local kind, number, value = string.match(payload, "^OC1|([AUR])|(%d%d%d%d)|(.+)$")
  if not kind or not pending or number ~= pending[1] then return end
  local target, result = string.match(value, "^([^|]+)|(.+)$")
  if target ~= mac12(transport.mac()) then return end
  pending = nil
  if kind == "R" then
    local message = result == "HAND" and "Hands already full"
      or result == "EMPTY" and "Nothing to place"
      or result == "PLATE" and "Plate already used" or "Rejected: " .. result
    show(message)
    effect("bad", 900)
    return
  end
  online = true
  if result == "RT" then held = "RAW TOMATO" show("Picked up tomato")
  elseif string.sub(result, 1, 1) == "P" then held = nil show("Added to Plate " .. string.sub(result, 2, 3))
  else show(nfc and "Host connected" or "NFC unavailable") end
  effect("ok", 700)
end

function on_enter(root)
  title = badge.ui.label(root, "OVERCOOKED PLAYER")
  title:set_font_size("large")
  title:align("top_mid", 0, 30)
  info = badge.ui.label(root, "Starting...")
  info:style({ text_font = 20, text_align = "center" })
  info:align("center", 0, 15)
  start()
end

function on_tick()
  local now = badge.sys.ms()
  if #inbox > 0 then receive(table.remove(inbox, 1)) end
  if pending and now >= pending[4] then
    if pending[3] < 4 then
      pending[3], pending[4] = pending[3] + 1, now + 800
      transport.send(pending[2])
    else
      pending, online = nil, false
      show("Host did not respond\nA: retry")
      effect("bad", 1000)
    end
  end
  if nfc and online and not pending and now >= (next_scan or 0) then
    next_scan = now + 200
    local card = badge.nfc.card()
    if card and (card.uid ~= last_uid or now - (last_uid_at or 0) >= 4000) then
      local text = badge.nfc.read_text()
      last_uid, last_uid_at, clear_at = card.uid, now, now + 600
      if text == "I:TOM" or string.match(text or "", "^P:0[1-4]$") then
        show("Checking " .. text)
        send("E", text)
      else
        show(text and "Not in MVP" or "Unreadable NFC tag")
        effect("bad", 700)
      end
    end
  end
  if clear_at and now >= clear_at then badge.nfc.clear() clear_at = nil end
  if now >= led_at then
    led_at, led_step = now + 100, led_step + 1
    if fx_end > 0 and now >= fx_end then fx, fx_end = "", 0 end
    badge.led.clear()
    if fx == "wait" then badge.led.set((led_step % 6) + 1, 0, 40, 255)
    elseif fx == "ok" and led_step % 2 == 0 then badge.led.set_all(0, 255, 30)
    elseif fx == "bad" and led_step % 2 == 0 then badge.led.set_all(255, 0, 0) end
    badge.led.show()
  end
end

function on_button(button, kind)
  if kind ~= badge.input.KIND.PRESSED or button ~= badge.input.BUTTON.A then return end
  if not radio then start()
  elseif not online and not pending then send("H", "P") end
end

function on_exit()
  if nfc then badge.nfc.disable() end
  if radio then transport.on_recv(nil) transport.disable() end
  badge.led.clear()
  badge.led.show()
end
