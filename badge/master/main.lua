-- HTN26 Overcooked IRL stationary gateway.
-- The app receives only the documented restricted badge.radio channel and
-- emits valid player packets through badge.sys.log() for the master Pi.

local MAX_RADIO_PAYLOAD = 44
local MIN_PACKET_LENGTH = 9 -- OC1|1|N|X
local MAX_COUNTER = 999999
local QUEUE_CAPACITY = 8
local MAX_FLUSH_PER_TICK = 4
local STATUS_INTERVAL_MS = 5000
local LED_INTERVAL_MS = 100
local RECEIVE_PULSE_MS = 450

local radio_enabled = false
local queue_mac = {}
local queue_rssi = {}
local queue_payload = {}
local queue_head = 1
local queue_tail = 1
local queue_count = 0

local valid_count = 0
local forwarded_count = 0
local invalid_count = 0
local queue_drop_count = 0
local radio_drop_count = 0

local last_mac = nil
local last_rssi = nil
local last_payload = nil
local last_receive_ms = -1000000
local next_led_ms = 0
local next_status_ms = 0

local radio_label
local packets_label
local drops_label
local detail_label
local last_label
local source_label

local shown_forwarded = -1
local shown_drops = -1
local shown_invalid = -1
local shown_queue_drops = -1
local shown_radio_drops = -1
local shown_last_payload = false
local shown_last_mac = false
local shown_last_rssi = false

local function increment_counter(value, amount)
  amount = amount or 1
  if value >= MAX_COUNTER then return MAX_COUNTER end
  local result = value + amount
  if result >= MAX_COUNTER then return MAX_COUNTER end
  return result
end

local function bounded_counter(value)
  if type(value) ~= "number" or value ~= value or value <= 0 then return 0 end
  if value >= MAX_COUNTER then return MAX_COUNTER end
  return math.floor(value)
end

local function add_counters(left, right)
  if left >= MAX_COUNTER - right then return MAX_COUNTER end
  return left + right
end

local function total_drop_count()
  return add_counters(add_counters(invalid_count, queue_drop_count), radio_drop_count)
end

-- Keep this filter deliberately stricter than a prefix-only check. It accepts
-- the documented OC1|sequence|type|value packet and no serial-control bytes.
local function valid_player_packet(payload)
  if type(payload) ~= "string" then return false end
  local length = #payload
  if length < MIN_PACKET_LENGTH or length > MAX_RADIO_PAYLOAD then return false end
  if string.sub(payload, 1, 4) ~= "OC1|" then return false end
  if string.find(payload, string.char(0), 1, true) ~= nil then return false end
  if string.find(payload, "\r", 1, true) ~= nil then return false end
  if string.find(payload, "\n", 1, true) ~= nil then return false end
  local sequence, kind, value = string.match(payload,
    "^OC1|([0-9]+)|([NMBH])|([^|]+)$")
  return sequence ~= nil and kind ~= nil and value ~= nil
end

local function serial_frame(mac, rssi, payload)
  return "HTN26|RX|" .. mac .. "|" .. tostring(rssi) .. "|" .. payload
end

local function enqueue_packet(mac, rssi, payload)
  if queue_count >= QUEUE_CAPACITY then
    queue_drop_count = increment_counter(queue_drop_count)
    return false
  end
  queue_mac[queue_tail] = mac
  queue_rssi[queue_tail] = rssi
  queue_payload[queue_tail] = payload
  queue_tail = queue_tail + 1
  if queue_tail > QUEUE_CAPACITY then queue_tail = 1 end
  queue_count = queue_count + 1
  return true
end

local function dequeue_packet()
  if queue_count == 0 then return nil end
  local mac = queue_mac[queue_head]
  local rssi = queue_rssi[queue_head]
  local payload = queue_payload[queue_head]
  queue_mac[queue_head] = nil
  queue_rssi[queue_head] = nil
  queue_payload[queue_head] = nil
  queue_head = queue_head + 1
  if queue_head > QUEUE_CAPACITY then queue_head = 1 end
  queue_count = queue_count - 1
  return mac, rssi, payload
end

local function receive_packet(mac, rssi, payload)
  -- This callback only validates and copies into the bounded queue. It does
  -- not touch widgets, LEDs, storage, or serial logging.
  if type(mac) ~= "string" or type(rssi) ~= "number" or
      not valid_player_packet(payload) then
    invalid_count = increment_counter(invalid_count)
    return
  end
  valid_count = increment_counter(valid_count)
  enqueue_packet(mac, rssi, payload)
end

local function update_radio_drops()
  local observed = badge.radio.dropped()
  if type(observed) == "number" then
    radio_drop_count = bounded_counter(observed)
  end
end

local function flush_packets(now)
  local flushed = 0
  while flushed < MAX_FLUSH_PER_TICK and queue_count > 0 do
    local mac, rssi, payload = dequeue_packet()
    badge.sys.log(serial_frame(mac, rssi, payload))
    forwarded_count = increment_counter(forwarded_count)
    last_mac = mac
    last_rssi = rssi
    last_payload = payload
    last_receive_ms = now
    flushed = flushed + 1
  end
end

local function update_display(force)
  local drops = total_drop_count()
  if force or shown_forwarded ~= forwarded_count then
    packets_label:set_text("Packets: " .. tostring(forwarded_count))
    shown_forwarded = forwarded_count
  end
  if force or shown_drops ~= drops then
    drops_label:set_text("Drops: " .. tostring(drops))
    shown_drops = drops
  end
  if force or shown_invalid ~= invalid_count or
      shown_queue_drops ~= queue_drop_count or
      shown_radio_drops ~= radio_drop_count then
    detail_label:set_text("Bad: " .. tostring(invalid_count) ..
      "   Queue: " .. tostring(queue_drop_count) ..
      "   Radio: " .. tostring(radio_drop_count))
    shown_invalid = invalid_count
    shown_queue_drops = queue_drop_count
    shown_radio_drops = radio_drop_count
  end
  if force or shown_last_payload ~= last_payload or
      shown_last_mac ~= last_mac or shown_last_rssi ~= last_rssi then
    if last_payload == nil then
      last_label:set_text("Last: none")
      source_label:set_text("Waiting for player packets")
    else
      last_label:set_text("Last: " .. last_payload)
      source_label:set_text("From " .. last_mac .. "  " ..
        tostring(last_rssi) .. " dBm")
    end
    shown_last_payload = last_payload
    shown_last_mac = last_mac
    shown_last_rssi = last_rssi
  end
end

local function render_leds(now)
  if now < next_led_ms then return end
  next_led_ms = now + LED_INTERVAL_MS
  badge.led.clear()
  if not radio_enabled then
    if math.floor(now / 350) % 2 == 0 then
      badge.led.set_all(180, 0, 0)
    end
  elseif now - last_receive_ms < RECEIVE_PULSE_MS then
    local remaining = RECEIVE_PULSE_MS - (now - last_receive_ms)
    local blue = 40 + math.floor(180 * remaining / RECEIVE_PULSE_MS)
    badge.led.set_all(0, math.floor(blue / 3), blue)
  elseif total_drop_count() > 0 then
    badge.led.set_all(180, 55, 0)
  else
    local phase = (now % 2000) / 1000
    local wave = phase <= 1 and phase or (2 - phase)
    local green = 20 + math.floor(70 * wave)
    badge.led.set_all(0, green, 0)
  end
  badge.led.show()
end

function on_enter(root)
  local title = badge.ui.label(root, "HTN26 GATEWAY")
  title:style({text_font = 20})
  title:align("top_mid", 0, 10)

  radio_label = badge.ui.label(root, "Radio: STARTING")
  radio_label:align("top_mid", 0, 40)

  packets_label = badge.ui.label(root, "Packets: 0")
  packets_label:align("top_mid", -72, 72)
  drops_label = badge.ui.label(root, "Drops: 0")
  drops_label:align("top_mid", 72, 72)

  detail_label = badge.ui.label(root, "Bad: 0   Queue: 0   Radio: 0")
  detail_label:style({text_font = 14, text_align = "center"})
  detail_label:align("top_mid", 0, 102)

  last_label = badge.ui.label(root, "Last: none")
  last_label:style({text_font = 14, text_align = "center"})
  last_label:align("center", 0, -12)
  source_label = badge.ui.label(root, "Waiting for player packets")
  source_label:style({text_font = 14, text_align = "center"})
  source_label:align("center", 0, 12)

  local footer = badge.ui.label(root, "USB log -> MASTER PI\nHOME exits")
  footer:style({text_font = 14, text_align = "center"})
  footer:align("bottom_mid", 0, -12)

  radio_enabled = badge.radio.enable() == true
  if radio_enabled then
    badge.radio.on_recv(receive_packet)
    radio_label:set_text("Radio: ONLINE")
  else
    radio_label:set_text("Radio: OFFLINE")
  end

  local now = badge.sys.ms()
  next_status_ms = now + STATUS_INTERVAL_MS
  update_display(true)
  render_leds(now)
  badge.sys.log("HTN26|GW|" .. (radio_enabled and "UP" or "DOWN") ..
    "|0|0")
end

function on_tick()
  local now = badge.sys.ms()
  if radio_enabled then update_radio_drops() end
  flush_packets(now)
  update_display(false)
  render_leds(now)
  if now >= next_status_ms then
    next_status_ms = now + STATUS_INTERVAL_MS
    badge.sys.log("HTN26|GW|" .. (radio_enabled and "UP" or "DOWN") ..
      "|" .. tostring(forwarded_count) .. "|" .. tostring(total_drop_count()))
  end
end

function on_exit()
  if radio_enabled then
    badge.radio.on_recv(nil)
    badge.radio.disable()
    radio_enabled = false
  end
  badge.led.clear()
  badge.led.show()
end
