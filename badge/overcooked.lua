--[==[badge-app
slug=overcooked_badge
name=Overcooked Badge
icon=OC
api=2
heap_kb=48
wake_lock=1
]==]

-- Overcooked badge MVP. UP/DOWN + A selects a role. START clears it and exits.

local PREFIX = "OC1|"
local RETRY_MS, MAX_TRIES = 800, 4
local NFC_POLL_MS, NFC_CLEAR_MS, NFC_REPEAT_MS = 200, 600, 4000
local RX_MAX = 8
local ROLE_NAMES = { "PLAYER", "HOST", "SERVE" }
local ERROR_TEXT = { HAND = "Hands already full", EMPTY = "Nothing to place",
  PLATE = "Plate already used", DISH = "WRONG DISH", NOTYET = "Not in MVP",
  JOIN = "Join host first", ROLE = "Wrong badge role", TAG = "Unknown plate" }

local role = badge.store.get_str("role", "")
local selecting = role ~= "P" and role ~= "H" and role ~= "S"
local seq = badge.store.get_int("seq", 0)
local radio_ok, nfc_ok, connected = false, false, false
local pending, rxq = nil, {}
local next_nfc_poll, clear_nfc_at = 0, 0
local last_uid, last_uid_at = nil, 0
local title, status, main, detail, hint

local effect, effect_until, next_led = "off", 0, 0
local led_step = 0

local clients, plates = {}, {}
local player_count, score, orders = 0, 0, 1

local function compact_mac(mac)
  return (string.gsub(mac or "", ":", ""))
end

local function player_id(mac)
  return string.sub(compact_mac(mac), -4)
end

local function packet(kind, number, value)
  return PREFIX .. kind .. "|" .. number .. "|" .. value
end

local function parse(payload)
  if type(payload) ~= "string" or #payload > 44 then return nil end
  return string.match(payload, "^OC1|([A-Z])|(%d%d%d%d)|(.+)$")
end

local function next_seq()
  seq = (seq + 1) % 10000
  badge.store.set_int("seq", seq)
  return string.format("%04d", seq)
end

local function set_effect(name, duration)
  effect, led_step, next_led = name, 0, 0
  effect_until = duration and (badge.sys.ms() + duration) or 0
end

local function draw_leds(now)
  if now < next_led then return end
  next_led = now + 100
  badge.led.clear()
  if effect == "wait" then
    led_step = (led_step % 6) + 1
    badge.led.set(led_step, 0, 40, 255)
  elseif effect == "ok" then
    led_step = led_step + 1
    if led_step % 2 == 1 then badge.led.set_all(0, 255, 30) end
  elseif effect == "bad" then
    led_step = led_step + 1
    if led_step % 2 == 1 then badge.led.set_all(255, 0, 0) end
  elseif role == "H" then
    badge.led.set_all(0, 20, 5)
  end
  badge.led.show()
  if effect_until > 0 and now >= effect_until then
    effect, effect_until = "off", 0
  end
end

local function show_select()
  title:set_text("OVERCOOKED")
  status:set_text("SELECT ROLE")
  local selected = role == "H" and 2 or role == "S" and 3 or 1
  main:set_text("<  " .. ROLE_NAMES[selected] .. "  >")
  detail:set_text("UP/DOWN choose")
  hint:set_text("A confirm   HOME exit")
end

local function update_host(last)
  status:set_text("HOST   Radio: " .. (radio_ok and "ONLINE" or "ERROR"))
  main:set_text(string.format("Players: %d\nOrders: %d\nScore: %d", player_count, orders, score))
  detail:set_text("Last:\n" .. (last or "Waiting for badges"))
end

local function update_client(last)
  if role == "P" then
    status:set_text("PLAYER   Host: " .. (connected and "ONLINE" or "SEARCHING"))
    main:set_text("Holding:\n" .. ((clients.me and clients.me.held) or "NOTHING"))
  else
    status:set_text("SERVING STATION")
    main:set_text(connected and "Place plate here" or "Finding host...")
  end
  detail:set_text("Last:\n" .. (last or "Waiting"))
end

local function send_pending(kind, value)
  if pending then
    update_client("Wait for host")
    set_effect("bad", 500)
    return false
  end
  local number = next_seq()
  local payload = packet(kind, number, value)
  if #payload > 44 then
    update_client("Message too long")
    set_effect("bad", 700)
    return false
  end
  pending = { seq = number, payload = payload, tries = 1,
    deadline = badge.sys.ms() + RETRY_MS }
  badge.radio.send(payload)
  set_effect("wait")
  return true
end

local function cache_response(client, number, response)
  local cache = client.cache
  cache[number] = response
  client.order[#client.order + 1] = number
  if #client.order > 6 then
    cache[client.order[1]] = nil
    table.remove(client.order, 1)
  end
end

local function reply(client, number, kind, value)
  local response = packet(kind, number, compact_mac(client.mac) .. "|" .. value)
  cache_response(client, number, response)
  badge.radio.send(response)
end

local function get_client(mac)
  local client = clients[mac]
  if not client then
    client = { mac = mac, role = "", held = nil, cache = {}, order = {} }
    clients[mac] = client
  end
  return client
end

local function host_hello(mac, number, value)
  if value ~= "P" and value ~= "S" then return end
  local client = get_client(mac)
  if client.role ~= value then
    if client.role == "P" then player_count = player_count - 1 end
    client.role = value
    client.held = nil
    if value == "P" then player_count = player_count + 1 end
    badge.sys.log("GAME|PLAYER_JOIN|" .. player_id(mac) .. "|" .. value)
  end
  reply(client, number, "A", "HOST")
  update_host(player_id(mac) .. " joined")
end

local function host_event(client, number, value)
  if client.role ~= "P" then reply(client, number, "R", "ROLE") return end
  if value == "I:TOM" then
    if client.held then reply(client, number, "R", "HAND") return end
    client.held = "RAW TOMATO"
    reply(client, number, "U", "RT")
    badge.sys.log("GAME|PICKUP|" .. player_id(client.mac) .. "|TOM")
    update_host(player_id(client.mac) .. " picked TOM")
    return
  end
  local plate = string.match(value, "^P:(0[1-4])$")
  if plate then
    if not client.held then reply(client, number, "R", "EMPTY") return end
    if plates[plate] then reply(client, number, "R", "PLATE") return end
    plates[plate], client.held = client.held, nil
    reply(client, number, "U", "P" .. plate)
    badge.sys.log("GAME|PLATE_ADD|" .. plate .. "|TOM")
    update_host(player_id(client.mac) .. " -> Plate " .. plate)
    return
  end
  reply(client, number, "R", "NOTYET")
end

local function host_serve(client, number, value)
  if client.role ~= "S" then reply(client, number, "R", "ROLE") return end
  local plate = string.match(value, "^P:(0[1-4])$")
  if not plate then reply(client, number, "R", "TAG") return end
  if plates[plate] ~= "RAW TOMATO" then
    reply(client, number, "R", "DISH")
    badge.sys.log("GAME|SUBMIT|" .. plate .. "|FAIL")
    update_host("Plate " .. plate .. " wrong dish")
    return
  end
  plates[plate] = nil
  score = score + 10
  reply(client, number, "U", "S" .. plate .. ":" .. score)
  badge.sys.log("GAME|SUBMIT|" .. plate .. "|OK")
  badge.sys.log("GAME|SCORE|" .. score)
  update_host("Plate " .. plate .. " complete")
end

local function host_receive(mac, payload)
  local kind, number, value = parse(payload)
  if not kind or (kind ~= "H" and kind ~= "E" and kind ~= "V") then return end
  local client = get_client(mac)
  local prior = client.cache[number]
  if prior then badge.radio.send(prior) return end
  if kind == "H" then host_hello(mac, number, value)
  elseif client.role == "" then reply(client, number, "R", "JOIN")
  elseif kind == "E" then host_event(client, number, value)
  else host_serve(client, number, value) end
end

local function client_receive(payload)
  local kind, number, value = parse(payload)
  if not kind or not pending or number ~= pending.seq then return end
  local target, result = string.match(value, "^([^|]+)|(.+)$")
  if target ~= compact_mac(badge.radio.mac()) then return end
  if kind ~= "A" and kind ~= "U" and kind ~= "R" then return end
  pending = nil
  if kind == "R" then
    update_client(ERROR_TEXT[result] or "Rejected")
    if role == "S" and result == "DISH" then main:set_text("WRONG DISH") end
    set_effect("bad", 900)
    return
  end
  connected = true
  if kind == "A" then
    update_client(nfc_ok and "Host connected" or "NFC unavailable")
  elseif role == "P" and result == "RT" then
    clients.me.held = "RAW TOMATO"
    update_client("Picked up tomato")
  elseif role == "P" and string.sub(result, 1, 1) == "P" then
    clients.me.held = nil
    update_client("Added to Plate " .. string.sub(result, 2, 3))
  elseif role == "S" and string.sub(result, 1, 1) == "S" then
    update_client("Plate " .. string.sub(result, 2, 3) .. " accepted")
    main:set_text("ORDER COMPLETE")
  end
  set_effect("ok", role == "S" and 1200 or 700)
end

local function process_rx()
  local count = math.min(2, #rxq)
  for _ = 1, count do
    local frame = table.remove(rxq, 1)
    if role == "H" then host_receive(frame.mac, frame.payload)
    else client_receive(frame.payload) end
  end
end

local function scan_nfc(now)
  if not nfc_ok or pending or not connected or now < next_nfc_poll then return end
  next_nfc_poll = now + NFC_POLL_MS
  local card = badge.nfc.card()
  if not card then return end
  if card.uid == last_uid and now - last_uid_at < NFC_REPEAT_MS then return end
  local text = badge.nfc.read_text()
  last_uid, last_uid_at, clear_nfc_at = card.uid, now, now + NFC_CLEAR_MS
  if not text then
    update_client("Unreadable NFC tag")
    set_effect("bad", 700)
    return
  end
  if role == "P" then
    if not string.match(text, "^[ISP]:[A-Z0-9]+$") then
      update_client("Unknown NFC tag")
      set_effect("bad", 700)
      return
    end
    update_client("Checking " .. text)
    send_pending("E", text)
  elseif role == "S" then
    local plate = string.match(text, "^P:(0[1-4])$")
    if not plate then
      update_client("Scan a plate")
      set_effect("bad", 700)
      return
    end
    main:set_text("Checking Plate " .. plate .. "...")
    send_pending("V", text)
  end
end

local function start_role()
  radio_ok = badge.radio.enable()
  if not radio_ok then
    status:set_text("Radio unavailable")
    set_effect("bad")
    return
  end
  set_effect("off")
  badge.radio.on_recv(function(mac, rssi, payload)
    if string.sub(payload or "", 1, 4) ~= PREFIX then return end
    if #rxq < RX_MAX then rxq[#rxq + 1] = { mac = mac, payload = payload } end
  end)
  if role == "H" then
    update_host()
    badge.sys.log("GAME|HOST|UP")
  else
    clients.me = { held = nil }
    nfc_ok = badge.nfc.enable()
    if nfc_ok then badge.nfc.clear() end
    update_client(nfc_ok and "Joining host" or "NFC unavailable")
    send_pending("H", role)
  end
  hint:set_text("START change role   HOME exit")
end

function on_enter(root)
  title = badge.ui.label(root, "OVERCOOKED")
  title:set_font_size("large")
  title:align("top_mid", 0, 12)
  status = badge.ui.label(root, "")
  status:align("top_mid", 0, 43)
  main = badge.ui.label(root, "")
  main:style({ text_font = 20, text_align = "center" })
  main:align("center", 0, -10)
  detail = badge.ui.label(root, "")
  detail:style({ text_font = 14, text_align = "center" })
  detail:align("bottom_mid", 0, -38)
  hint = badge.ui.label(root, "")
  hint:style({ text_font = 14, text_color = badge.ui.theme.text_muted })
  hint:align("bottom_mid", 0, -10)
  if selecting then
    role = "P"
    show_select()
  else
    start_role()
  end
end

function on_tick()
  local now = badge.sys.ms()
  draw_leds(now)
  process_rx()
  if clear_nfc_at > 0 and now >= clear_nfc_at then
    badge.nfc.clear()
    clear_nfc_at = 0
  end
  if pending and now >= pending.deadline then
    if pending.tries < MAX_TRIES then
      pending.tries = pending.tries + 1
      pending.deadline = now + RETRY_MS
      badge.radio.send(pending.payload)
    else
      pending = nil
      connected = false
      update_client("Host did not respond")
      set_effect("bad", 1000)
    end
  end
  if role == "P" or role == "S" then scan_nfc(now) end
end

function on_button(button, kind)
  if kind ~= badge.input.KIND.PRESSED then return end
  if selecting then
    if button == badge.input.BUTTON.UP or button == badge.input.BUTTON.DOWN then
      role = role == "P" and "H" or role == "H" and "S" or "P"
      show_select()
    elseif button == badge.input.BUTTON.A then
      selecting = false
      badge.store.set_str("role", role)
      start_role()
    end
    return
  end
  if button == badge.input.BUTTON.START then
    badge.store.set_str("role", "")
    badge.app.exit()
  elseif not radio_ok and button == badge.input.BUTTON.A then
    start_role()
  elseif (role == "P" or role == "S") and button == badge.input.BUTTON.A and not connected and not pending then
    send_pending("H", role)
  end
end

function on_exit()
  if nfc_ok then badge.nfc.disable() end
  if radio_ok then
    badge.radio.on_recv(nil)
    badge.radio.disable()
  end
  badge.led.clear()
  badge.led.show()
end
