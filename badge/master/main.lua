-- HTN26 host badge for the single-Pi v1 game.
--
-- The host owns the round lifecycle and countdown. It is a radio gateway only:
-- player radio payloads are forwarded to the Pi over USB serial, while the Pi
-- remains authoritative for player intent, orders, scoring, and game state.

local GAME_DURATION_MS = 120000
local PLAYER_COUNT = 3
local MAX_RADIO_PAYLOAD = 44
local MAX_PACKET_SEQUENCE = 4294967295
local QUEUE_CAPACITY = 8
local MAX_FLUSH_PER_TICK = 4
local MAX_COUNTER = 999999
local DISPLAY_INTERVAL_MS = 100
local LED_INTERVAL_MS = 100
local STATUS_INTERVAL_MS = 5000

local game_active = false
local game_ends_at = 0
local remaining_seconds = 0
local session_number = 0
local session_received = 0
local session_forwarded = 0

local radio_enabled = false
local queue_mac = {}
local queue_rssi = {}
local queue_payload = {}
local queue_head = 1
local queue_tail = 1
local queue_count = 0

local forwarded_count = 0
local invalid_count = 0
local ignored_count = 0
local queue_drop_count = 0
local radio_drop_count = 0
local last_sender = nil
local last_rssi = nil
local last_payload = nil
local last_event_ms = -1000000
local last_status_log_ms = -1000000
local next_display_ms = 0
local next_led_ms = 0

-- These slots are deliberately reset for every round. The host does not assign
-- players dynamically; the Pi maps each sender identity to one of the three
-- pre-assigned players.
local players = {}

local status_label
local timer_label
local radio_label
local counters_label
local event_label
local shown_status = nil
local shown_timer = nil
local shown_radio = nil
local shown_counters = nil
local shown_event = nil

local function increment_counter(value, amount)
  amount = amount or 1
  if value >= MAX_COUNTER then return MAX_COUNTER end
  local result = value + amount
  if result >= MAX_COUNTER then return MAX_COUNTER end
  return result
end

local function reset_queue()
  for index = 1, QUEUE_CAPACITY do
    queue_mac[index] = nil
    queue_rssi[index] = nil
    queue_payload[index] = nil
  end
  queue_head = 1
  queue_tail = 1
  queue_count = 0
end

local function reset_players()
  for index = 1, PLAYER_COUNT do
    players[index] = {
      sender = nil,
      received = 0,
      last_sequence = nil,
      held_item = nil,
      action = "IDLE",
    }
  end
end

local function reset_session()
  reset_queue()
  reset_players()
  session_received = 0
  session_forwarded = 0
  last_sender = nil
  last_rssi = nil
  last_payload = nil
  last_event_ms = -1000000
end

local function valid_mac(mac)
  if type(mac) ~= "string" or #mac ~= 17 then return false end
  for index = 1, 17 do
    local character = string.sub(mac, index, index)
    if index % 3 == 0 then
      if character ~= ":" then return false end
    elseif string.match(character, "^[0-9A-Fa-f]$") == nil then
      return false
    end
  end
  return true
end

local function valid_rssi(rssi)
  return type(rssi) == "number" and rssi == math.floor(rssi) and
    rssi >= -127 and rssi <= 20
end

local function valid_sequence(sequence)
  if type(sequence) ~= "string" or #sequence < 1 then return false end
  local number = 0
  for index = 1, #sequence do
    local digit = string.byte(sequence, index) - string.byte("0")
    if digit < 0 or digit > 9 then return false end
    if number > math.floor((MAX_PACKET_SEQUENCE - digit) / 10) then
      return false
    end
    number = number * 10 + digit
  end
  return true
end

local function printable_value(value)
  if type(value) ~= "string" or #value == 0 then return false end
  for index = 1, #value do
    local byte = string.byte(value, index)
    if byte < 32 or byte > 126 or byte == 124 then return false end
  end
  return true
end

-- This is the sequence-first OC1 payload consumed by pi/common/protocol.cpp:
-- OC1|<sequence>|<type>|<value>. The value cannot contain a pipe, newline, or
-- other control character so the surrounding serial fields stay unambiguous.
local function valid_player_packet(payload)
  if type(payload) ~= "string" or #payload < 9 or #payload > MAX_RADIO_PAYLOAD then
    return false
  end
  if string.sub(payload, 1, 4) ~= "OC1|" then return false end
  if string.find(payload, string.char(0), 1, true) ~= nil then return false end
  if string.find(payload, "\r", 1, true) ~= nil then return false end
  if string.find(payload, "\n", 1, true) ~= nil then return false end

  local sequence, event_type, value = string.match(payload,
    "^OC1|([^|]+)|([NMBH])|([^|]+)$")
  if sequence == nil or not valid_sequence(sequence) or
      not printable_value(value) then
    return false
  end
  return true
end

local function serial_rx_frame(mac, rssi, payload)
  return "HTN26|RX|" .. mac .. "|" .. tostring(rssi) .. "|" .. payload
end

local function serial_start_frame()
  return "HTN26|GAME|START_GAME|120|3"
end

local function serial_end_frame()
  return "HTN26|GAME|GAME_END|3"
end

local function lifecycle_radio_frame(kind)
  if kind == "START_GAME" then
    return "HTN26|GAME|START_GAME|120|3"
  end
  return "HTN26|GAME|GAME_END|3"
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
  -- Radio callbacks are kept short. In particular, they never log, touch UI,
  -- or call radio.send; the normal tick drains this bounded FIFO.
  if not valid_mac(mac) or not valid_rssi(rssi) or
      not valid_player_packet(payload) then
    invalid_count = increment_counter(invalid_count)
    return
  end
  if not game_active then
    ignored_count = increment_counter(ignored_count)
    return
  end
  if enqueue_packet(mac, rssi, payload) then
    session_received = increment_counter(session_received)
  end
end

local function update_radio_drops()
  local observed = badge.radio.dropped()
  if type(observed) ~= "number" then return end
  observed = math.floor(observed)
  if observed < 0 then observed = 0 end
  if observed > MAX_COUNTER then observed = MAX_COUNTER end
  radio_drop_count = observed
end

local function flush_packets(now)
  local flushed = 0
  while flushed < MAX_FLUSH_PER_TICK and queue_count > 0 do
    local mac, rssi, payload = dequeue_packet()
    badge.sys.log(serial_rx_frame(mac, rssi, payload))
    forwarded_count = increment_counter(forwarded_count)
    session_forwarded = increment_counter(session_forwarded)
    last_sender = mac
    last_rssi = rssi
    last_payload = payload
    last_event_ms = now
    flushed = flushed + 1
  end
end

local function format_clock(seconds)
  if seconds < 0 then seconds = 0 end
  local minutes = math.floor(seconds / 60)
  local remainder = seconds - minutes * 60
  local second_text = tostring(remainder)
  if remainder < 10 then second_text = "0" .. second_text end
  return tostring(minutes) .. ":" .. second_text
end

local function current_status()
  if game_active then return "GAME ACTIVE" end
  if session_number == 0 then return "HOST READY - PRESS START" end
  return "GAME ENDED - PRESS START"
end

local function current_timer()
  if game_active then return format_clock(remaining_seconds) end
  return "--:--"
end

local function update_display(force)
  local status = current_status()
  if force or shown_status ~= status then
    status_label:set_text(status)
    shown_status = status
  end

  local timer = current_timer()
  if force or shown_timer ~= timer then
    timer_label:set_text(timer)
    shown_timer = timer
  end

  local radio = "RADIO " .. (radio_enabled and "ONLINE" or "UNAVAILABLE") ..
    "  /  USB SERIAL OUT"
  if force or shown_radio ~= radio then
    radio_label:set_text(radio)
    shown_radio = radio
  end

  local counters = "Session RX " .. tostring(session_forwarded) ..
    "  Total " .. tostring(forwarded_count) ..
    "  Drop " .. tostring(queue_drop_count + radio_drop_count)
  if force or shown_counters ~= counters then
    counters_label:set_text(counters)
    shown_counters = counters
  end

  local event = "Last: none"
  if last_payload then
    event = "Last " .. last_sender .. " " .. tostring(last_rssi) .. " dBm\n" .. last_payload
  elseif not game_active and session_number > 0 then
    event = "Round reset - player state cleared"
  end
  if force or shown_event ~= event then
    event_label:set_text(event)
    shown_event = event
  end
end

local function render_leds(now)
  if now < next_led_ms then return end
  next_led_ms = now + LED_INTERVAL_MS
  badge.led.clear()
  if not radio_enabled then
    if math.floor(now / 350) % 2 == 0 then badge.led.set_all(180, 0, 0) end
  elseif game_active then
    local seconds = remaining_seconds
    local lit = math.max(1, math.min(6, math.ceil(seconds / 20)))
    for index = 1, lit do badge.led.set(index, 0, 130, 35) end
    if last_event_ms > 0 and now - last_event_ms < 300 then
      badge.led.set_all(0, 70, 220)
    end
  else
    local phase = (now % 2000) / 1000
    local wave = phase <= 1 and phase or (2 - phase)
    badge.led.set_all(0, 20 + math.floor(70 * wave), 0)
  end
  badge.led.show()
end

local function emit_lifecycle(kind)
  -- The serial record is the Pi-facing contract. The radio broadcast is only
  -- a best-effort badge-to-badge lifecycle hint; there is no Pi-to-badge API
  -- or acknowledgement path in this app.
  local serial_frame
  if kind == "START_GAME" then
    serial_frame = serial_start_frame()
  else
    serial_frame = serial_end_frame()
  end
  badge.sys.log(serial_frame)
  local broadcast_queued = false
  if radio_enabled then
    broadcast_queued = badge.radio.send(lifecycle_radio_frame(kind)) == true
  end
  return broadcast_queued
end

local function start_game(now)
  if game_active then return false end
  reset_session()
  session_number = increment_counter(session_number)
  game_active = true
  game_ends_at = now + GAME_DURATION_MS
  remaining_seconds = 120
  emit_lifecycle("START_GAME")
  return true
end

local function end_game()
  if not game_active then return false end
  -- Drop queued player events and clear all three player slots before the end
  -- record, so no event from the old round can leak into the next one.
  game_active = false
  game_ends_at = 0
  remaining_seconds = 0
  reset_session()
  emit_lifecycle("GAME_END")
  return true
end

local function update_timer(now)
  if not game_active then return end
  local remaining_ms = game_ends_at - now
  if remaining_ms <= 0 then
    end_game()
    return
  end
  remaining_seconds = math.ceil(remaining_ms / 1000)
end

function on_enter(root)
  local title = badge.ui.label(root, "HTN26 HOST / SINGLE PI")
  title:style({text_font = 20})
  title:align("top_mid", 0, 8)

  status_label = badge.ui.label(root, "HOST READY - PRESS START")
  status_label:style({text_font = 18, text_align = "center"})
  status_label:align("top_mid", 0, 38)

  timer_label = badge.ui.label(root, "--:--")
  timer_label:style({text_font = 24, text_align = "center"})
  timer_label:align("top_mid", 0, 68)

  radio_label = badge.ui.label(root, "RADIO STARTING")
  radio_label:style({text_font = 14, text_align = "center"})
  radio_label:align("top_mid", 0, 104)

  counters_label = badge.ui.label(root, "Session RX 0  Total 0  Drop 0")
  counters_label:style({text_font = 14, text_align = "center"})
  counters_label:align("top_mid", 0, 126)

  event_label = badge.ui.label(root, "Last: none")
  event_label:style({text_font = 14, text_align = "center"})
  event_label:align("center", 0, 18)

  local hint_label = badge.ui.label(root, "START new round   HOME exits")
  hint_label:style({text_font = 14, text_align = "center"})
  hint_label:align("bottom_mid", 0, -12)

  reset_session()
  radio_enabled = badge.radio.enable() == true
  if radio_enabled then
    badge.radio.on_recv(receive_packet)
  end

  next_display_ms = 0
  next_led_ms = 0
  update_display(true)
  render_leds(badge.sys.ms())
  badge.sys.log("HTN26|GW|" .. (radio_enabled and "UP" or "DOWN") .. "|0|0")
end

function on_tick()
  local now = badge.sys.ms()
  if radio_enabled then update_radio_drops() end
  if game_active then update_timer(now) end
  if game_active then flush_packets(now) end
  if now >= next_display_ms then
    next_display_ms = now + DISPLAY_INTERVAL_MS
    update_display(false)
  end
  render_leds(now)
  if now - last_status_log_ms >= STATUS_INTERVAL_MS then
    last_status_log_ms = now
    badge.sys.log("HTN26|GW|" .. (radio_enabled and "UP" or "DOWN") ..
      "|" .. tostring(forwarded_count) .. "|" ..
      tostring(queue_drop_count + radio_drop_count))
  end
end

function on_button(button, kind)
  if kind ~= badge.input.KIND.PRESSED then return end
  if button == badge.input.BUTTON.START then
    if start_game(badge.sys.ms()) then
      update_display(true)
    end
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

-- Pure helpers are exported only for host-side protocol tests. The badge
-- sandbox always has a badge table, so this branch is never used on-device.
if badge == nil then
  gateway_test = {
    valid_mac = valid_mac,
    valid_rssi = valid_rssi,
    valid_player_packet = valid_player_packet,
    serial_rx_frame = serial_rx_frame,
    serial_start_frame = serial_start_frame,
    serial_end_frame = serial_end_frame,
    lifecycle_radio_frame = lifecycle_radio_frame,
    reset_queue = reset_queue,
    enqueue_packet = enqueue_packet,
    dequeue_packet = dequeue_packet,
    queue_size = function() return queue_count end,
    queue_drops = function() return queue_drop_count end,
    reset_session = reset_session,
    player_count = function() return #players end,
  }
end
