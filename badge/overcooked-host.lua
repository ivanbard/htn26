--[==[badge-app
slug=overcooked_host
name=Overcooked Host
icon=HOST
api=2
heap_kb=48
wake_lock=1
]==]

local transport = require("transport")

local radio = false
local title, info
local inbox, clients, plates = {}, {}, {}
local players, score, flash_end, led_at = 0, 0, 0, 0

local function mac12(value)
  return (string.gsub(value or "", ":", ""))
end

local function show(last)
  title:set_text("HOST  Radio: " .. (radio and "ONLINE" or "ERROR"))
  info:set_text(string.format("Players: %d\nOrders: 1\nScore: %d\n\n%s", players, score, last or "Waiting for badges"))
end

local function reply(client, number, kind, value)
  local response = "OC1|" .. kind .. "|" .. number .. "|" .. mac12(client.mac) .. "|" .. value
  client.seen[number] = response
  client.order[#client.order + 1] = number
  if #client.order > 4 then
    client.seen[client.order[1]] = nil
    table.remove(client.order, 1)
  end
  transport.send(response)
end

local function receive(mac, payload)
  if #payload > 44 then return end
  local kind, number, value = string.match(payload, "^OC1|([HEV])|(%d%d%d%d)|(.+)$")
  if not kind then return end
  local client = clients[mac]
  if not client then
    client = { mac = mac, role = "", held = nil, seen = {}, order = {} }
    clients[mac] = client
  end
  if client.seen[number] then transport.send(client.seen[number]) return end

  if kind == "H" then
    if value ~= "P" and value ~= "S" then return end
    if client.role ~= value then
      if client.role == "P" then players = players - 1 end
      client.role, client.held = value, nil
      if value == "P" then players = players + 1 end
      badge.sys.log("GAME|PLAYER_JOIN|" .. string.sub(mac12(mac), -4) .. "|" .. value)
    end
    reply(client, number, "A", "HOST")
    show(string.sub(mac12(mac), -4) .. " joined")
    return
  end
  if client.role == "" then reply(client, number, "R", "JOIN") return end

  if kind == "E" and client.role == "P" then
    if value == "I:TOM" then
      if client.held then reply(client, number, "R", "HAND") return end
      client.held = "RAW TOMATO"
      reply(client, number, "U", "RT")
      badge.sys.log("GAME|PICKUP|" .. string.sub(mac12(mac), -4) .. "|TOM")
      show("Tomato picked up")
      return
    end
    local plate = string.match(value, "^P:(0[1-4])$")
    if plate then
      if not client.held then reply(client, number, "R", "EMPTY") return end
      if plates[plate] then reply(client, number, "R", "PLATE") return end
      plates[plate], client.held = client.held, nil
      reply(client, number, "U", "P" .. plate)
      badge.sys.log("GAME|PLATE_ADD|" .. plate .. "|TOM")
      show("Added to Plate " .. plate)
      return
    end
  elseif kind == "V" and client.role == "S" then
    local plate = string.match(value, "^P:(0[1-4])$")
    if not plate then reply(client, number, "R", "TAG") return end
    if plates[plate] ~= "RAW TOMATO" then
      reply(client, number, "R", "DISH")
      badge.sys.log("GAME|SUBMIT|" .. plate .. "|FAIL")
      show("Plate " .. plate .. " wrong")
      return
    end
    plates[plate], score = nil, score + 10
    reply(client, number, "U", "S" .. plate)
    badge.sys.log("GAME|SUBMIT|" .. plate .. "|OK")
    badge.sys.log("GAME|SCORE|" .. score)
    show("Plate " .. plate .. " complete")
    flash_end = badge.sys.ms() + 1200
    return
  end
  reply(client, number, "R", client.role == (kind == "V" and "S" or "P") and "NOTYET" or "ROLE")
end

local function start()
  radio = transport.enable()
  if not radio then
    title:set_text("TRANSPORT UNAVAILABLE")
    info:set_text("A: RETRY\nHOME: EXIT")
    return
  end
  transport.on_recv(function(mac, rssi, payload)
    if #inbox < 6 and string.sub(payload or "", 1, 4) == "OC1|" then inbox[#inbox + 1] = { mac, payload } end
  end)
  show()
  badge.sys.log("GAME|HOST|UP")
end

function on_enter(root)
  title = badge.ui.label(root, "OVERCOOKED HOST")
  title:set_font_size("large")
  title:align("top_mid", 0, 25)
  info = badge.ui.label(root, "Starting...")
  info:style({ text_font = 20, text_align = "center" })
  info:align("center", 0, 20)
  start()
end

function on_tick()
  if #inbox > 0 then
    local frame = table.remove(inbox, 1)
    receive(frame[1], frame[2])
  end
  local now = badge.sys.ms()
  if now >= led_at then
    led_at = now + 120
    badge.led.clear()
    if now < flash_end then badge.led.set_all(0, 255, 30)
    else badge.led.set_all(0, 20, 5) end
    badge.led.show()
  end
end

function on_button(button, kind)
  if kind == badge.input.KIND.PRESSED and button == badge.input.BUTTON.A and not radio then start() end
end

function on_exit()
  if radio then transport.on_recv(nil) transport.disable() end
  badge.led.clear()
  badge.led.show()
end
