local transport = badge and require("transport")

-- HTN26 Overcooked IRL serving-area master badge.
-- START requests the one-Pi/phone-photo burger room scan. The badge has serial output
-- only, so the Pi owns floor-plan capture and approval after that log line.
-- Update 1 uses all four NFC tags as player stations; the host is radio/serial only.

local MAX_RADIO_PAYLOAD = 44
local MIN_PACKET_LENGTH = 9 -- OC1|1|N|X
local MAX_COUNTER = 999999
local QUEUE_CAPACITY = 8
local MAX_FLUSH_PER_TICK = 4
local STATUS_INTERVAL_MS = 5000
local LED_INTERVAL_MS = 100
local RECEIVE_PULSE_MS = 450
local PLATE_PULSE_MS = 700
local NFC_POLL_MS = 200
local NFC_CLEAR_MS = 600
local NFC_REPEAT_MS = 4000
local SCAN_COOLDOWN_MS = 3000

local radio_enabled = false
local nfc_enabled = false
local queue_mac = {}
local queue_rssi = {}
local queue_payload = {}
local queue_head = 1
local queue_tail = 1
local queue_count = 0

local forwarded_count = 0
local invalid_count = 0
local queue_drop_count = 0
local radio_drop_count = 0
local nfc_bad_count = 0
local plate_count = 0

local last_mac = nil
local last_rssi = nil
local last_payload = nil
local last_event_text = nil
local last_event_source = nil
local last_receive_ms = -1000000
local last_plate_ms = -1000000
local scan_flash_until = 0
local next_led_ms = 0
local next_status_ms = 0
local next_scan_allowed = 0
local next_nfc_poll = 0
local clear_nfc_at = 0
local last_nfc_uid = nil
local last_nfc_uid_ms = -1000000
local scan_phase = "READY - START room scan"

local radio_label
local nfc_label
local scan_label
local counter_label
local plate_label
local detail_label
local last_label
local source_label

local shown_health = nil
local shown_scan = nil
local shown_forwarded = -1
local shown_drops = -1
local shown_plates = -1
local shown_invalid = -1
local shown_queue_drops = -1
local shown_radio_drops = -1
local shown_nfc_bad = -1
local shown_last_text = false
local shown_last_source = false

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
  local total = add_counters(invalid_count, queue_drop_count)
  total = add_counters(total, radio_drop_count)
  return add_counters(total, nfc_bad_count)
end

-- Accept both the documented sequence/type/value order and the order emitted
-- by the current player badge: OC1|<type>|<4-digit sequence>|<value>.
local function valid_player_packet(payload)
  if type(payload) ~= "string" then return false end
  local length = #payload
  if length < MIN_PACKET_LENGTH or length > MAX_RADIO_PAYLOAD then return false end
  if string.sub(payload, 1, 4) ~= "OC1|" then return false end
  if string.find(payload, string.char(0), 1, true) ~= nil then return false end
  if string.find(payload, "\r", 1, true) ~= nil then return false end
  if string.find(payload, "\n", 1, true) ~= nil then return false end
  local kind, sequence, value = string.match(payload,
    "^OC1|([A-Z])|(%d%d%d%d)|([^|]+)$")
  if kind == nil then
    -- Targeted three-badge replies carry an additional MAC field.
    kind, sequence, value = string.match(payload,
      "^OC1|([AUR])|(%d%d%d%d)|(%x%x%x%x%x%x%x%x%x%x%x%x|[^|]+)$")
  end
  if kind == nil then
    sequence, kind, value = string.match(payload,
      "^OC1|([0-9]+)|([A-Z])|([^|]+)$")
  end
  return sequence ~= nil and kind ~= nil and value ~= nil
end

local function valid_plate_tag(text)
  if type(text) ~= "string" or #text ~= 4 then return false end
  return string.match(text, "^P:0[1-3]$") ~= nil
end

local function serial_frame(mac, rssi, payload)
  return "HTN26|RX|" .. mac .. "|" .. tostring(rssi) .. "|" .. payload
end

local function plate_frame(tag)
  return "HTN26|PLATE|" .. tag
end

local function host_scan_frame()
  return "HTN26|HOST|SCAN|1PI|PHONE|BURGER"
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
  -- Keep this callback short: validate and copy only. UI, NFC, LEDs, and
  -- serial logging happen in normal bounded tick work.
  if type(mac) ~= "string" or type(rssi) ~= "number" or
      not valid_player_packet(payload) then
    invalid_count = increment_counter(invalid_count)
    return
  end
  enqueue_packet(mac, rssi, payload)
end

local function update_radio_drops()
  local observed = transport.dropped()
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
    last_event_text = payload
    last_event_source = "From " .. mac .. "  " .. tostring(rssi) .. " dBm"
    last_receive_ms = now
    flushed = flushed + 1
  end
end

local function poll_nfc(now)
  if not nfc_enabled or now < next_nfc_poll then return end
  next_nfc_poll = now + NFC_POLL_MS
  local card = badge.nfc.card()
  if not card or type(card.uid) ~= "string" then return end
  if card.uid == last_nfc_uid and now - last_nfc_uid_ms < NFC_REPEAT_MS then return end
  last_nfc_uid = card.uid
  last_nfc_uid_ms = now
  clear_nfc_at = now + NFC_CLEAR_MS

  local text = badge.nfc.read_text()
  if not valid_plate_tag(text) then
    nfc_bad_count = increment_counter(nfc_bad_count)
    last_event_text = "Non-plate NFC tag"
    last_event_source = "Serving NFC rejected"
    return
  end

  badge.sys.log(plate_frame(text))
  plate_count = increment_counter(plate_count)
  last_event_text = "Plate " .. text .. " delivered"
  last_event_source = "NFC -> master Pi"
  last_plate_ms = now
end

local function update_display(force)
  local health = "Radio: " .. (radio_enabled and "ONLINE" or "OFFLINE") ..
    "  NFC: PLAYER STATIONS"
  if force or shown_health ~= health then
    radio_label:set_text(health)
    shown_health = health
  end
  if force or shown_scan ~= scan_phase then
    scan_label:set_text(scan_phase)
    shown_scan = scan_phase
  end

  local drops = total_drop_count()
  if force or shown_forwarded ~= forwarded_count or shown_drops ~= drops then
    counter_label:set_text("RX: " .. tostring(forwarded_count) ..
      "   Drops: " .. tostring(drops))
    shown_forwarded = forwarded_count
    shown_drops = drops
  end
  if force or shown_plates ~= plate_count then
    plate_label:set_text("Submissions: forwarded by radio")
    shown_plates = plate_count
  end
  if force or shown_invalid ~= invalid_count or
      shown_queue_drops ~= queue_drop_count or
      shown_radio_drops ~= radio_drop_count or
      shown_nfc_bad ~= nfc_bad_count then
    detail_label:set_text("BadRX " .. tostring(invalid_count) ..
      "  Queue " .. tostring(queue_drop_count) ..
      "  Ring " .. tostring(radio_drop_count))
    shown_invalid = invalid_count
    shown_queue_drops = queue_drop_count
    shown_radio_drops = radio_drop_count
    shown_nfc_bad = nfc_bad_count
  end
  if force or shown_last_text ~= last_event_text or
      shown_last_source ~= last_event_source then
    last_label:set_text(last_event_text and ("Last: " .. last_event_text) or
      "Last: none")
    source_label:set_text(last_event_source or "Waiting for badges or plate")
    shown_last_text = last_event_text
    shown_last_source = last_event_source
  end
end

local function render_leds(now)
  if now < next_led_ms then return end
  next_led_ms = now + LED_INTERVAL_MS
  badge.led.clear()
  if not radio_enabled then
    if math.floor(now / 350) % 2 == 0 then badge.led.set_all(180, 0, 0) end
  elseif now - last_plate_ms < PLATE_PULSE_MS then
    badge.led.set_all(0, 190, 45)
  elseif now - last_receive_ms < RECEIVE_PULSE_MS then
    badge.led.set_all(0, 45, 190)
  elseif now < scan_flash_until then
    badge.led.set_all(190, 90, 0)
  elseif total_drop_count() > 0 then
    badge.led.set_all(180, 55, 0)
  else
    local phase = (now % 2000) / 1000
    local wave = phase <= 1 and phase or (2 - phase)
    badge.led.set_all(0, 20 + math.floor(70 * wave), 0)
  end
  badge.led.show()
end

local function request_room_scan(now)
  if now < next_scan_allowed then
    scan_phase = "SCAN RATE LIMITED"
    scan_flash_until = now + 250
    return
  end
  next_scan_allowed = now + SCAN_COOLDOWN_MS
  scan_phase = "SCAN REQUESTED - floor plan pending"
  scan_flash_until = now + 700
  -- The Pi sees this over serial and owns phone-photo upload, local inference,
  -- floor-plan approval, and tag-placement instructions.
  badge.sys.log(host_scan_frame())
end

function on_enter(root)
  local title = badge.ui.label(root, "HTN26 HOST / BURGER")
  title:style({ text_font = 20 })
  title:align("top_mid", 0, 8)

  radio_label = badge.ui.label(root, "Radio: STARTING")
  radio_label:style({ text_font = 14, text_align = "center" })
  radio_label:align("top_mid", 0, 36)

  scan_label = badge.ui.label(root, scan_phase)
  scan_label:style({ text_font = 14, text_align = "center" })
  scan_label:align("top_mid", 0, 59)

  counter_label = badge.ui.label(root, "RX: 0   Drops: 0")
  counter_label:align("top_mid", 0, 86)
  plate_label = badge.ui.label(root, "Submissions: forwarded by radio")
  plate_label:align("top_mid", 0, 108)

  detail_label = badge.ui.label(root, "BadRX 0  Queue 0  Ring 0")
  detail_label:style({ text_font = 14, text_align = "center" })
  detail_label:align("top_mid", 0, 132)

  last_label = badge.ui.label(root, "Last: none")
  last_label:style({ text_font = 14, text_align = "center" })
  last_label:align("center", 0, -8)
  source_label = badge.ui.label(root, "Waiting for player badges")
  source_label:style({ text_font = 14, text_align = "center" })
  source_label:align("center", 0, 14)

  local footer = badge.ui.label(root, "START scan room   HOME exits")
  footer:style({ text_font = 14, text_align = "center" })
  footer:align("bottom_mid", 0, -10)

  radio_enabled = transport.enable() == true
  if radio_enabled then transport.on_recv(receive_packet) end
  nfc_enabled = false

  local now = badge.sys.ms()
  next_status_ms = now + STATUS_INTERVAL_MS
  update_display(true)
  render_leds(now)
  badge.sys.log("HTN26|GW|" .. (radio_enabled and "UP" or "DOWN") .. "|0|0")
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

function on_button(button, kind)
  if kind ~= badge.input.KIND.PRESSED then return end
  if button == badge.input.BUTTON.START then
    request_room_scan(badge.sys.ms())
  end
end

function on_exit()
  if radio_enabled then
    transport.on_recv(nil)
    transport.disable()
    radio_enabled = false
  end
  badge.led.clear()
  badge.led.show()
end

-- Host-only exports let the repository's tests execute these pure helpers in
-- a normal Lua interpreter. The badge sandbox never enters this branch.
if badge == nil then
  gateway_test = {
    valid_player_packet = valid_player_packet,
    valid_plate_tag = valid_plate_tag,
    serial_frame = serial_frame,
    plate_frame = plate_frame,
    host_scan_frame = host_scan_frame,
    increment_counter = increment_counter,
    reset_queue = function()
      for index = 1, QUEUE_CAPACITY do
        queue_mac[index] = nil
        queue_rssi[index] = nil
        queue_payload[index] = nil
      end
      queue_head = 1
      queue_tail = 1
      queue_count = 0
      queue_drop_count = 0
    end,
    enqueue_packet = enqueue_packet,
    dequeue_packet = dequeue_packet,
    queue_size = function() return queue_count end,
    queue_drops = function() return queue_drop_count end,
  }
end
