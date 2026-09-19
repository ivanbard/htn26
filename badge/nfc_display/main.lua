-- Minimal standalone NFC reader for the HTN26 Hacker Badge.
-- The documented Lua API exposes the card UID and the first NDEF Text record.

local NFC_POLL_MS = 200
local NFC_CLEAR_MS = 900
local MAX_RECORD_BYTES = 96
local MAX_LINE_BYTES = 30

local nfc_enabled = false
local next_poll = 0
local seen_uid = nil
local rearm_uid = nil
local clear_at = 0

local status_label
local uid_label
local record_label
local detail_label

local led_mode = "wait"
local led_until = 0
local next_led = 0

local function set_led_mode(mode, until_ms)
  led_mode = mode
  led_until = until_ms or 0
  next_led = 0
end

local function render_leds(now)
  if led_until ~= 0 and now >= led_until then
    led_mode = "wait"
    led_until = 0
    next_led = 0
  end
  if now < next_led then return end
  next_led = now + 150

  badge.led.clear()
  if led_mode == "wait" then
    local bright = math.floor(now / 300) % 2 == 0
    badge.led.set_all(0, 35, bright and 150 or 70)
  elseif led_mode == "success" then
    badge.led.set_all(0, 180, 45)
  else
    local bright = math.floor(now / 180) % 2 == 0
    badge.led.set_all(bright and 210 or 90, 0, 0)
  end
  badge.led.show()
end

local function clean_detail(value)
  if type(value) ~= "string" or #value == 0 then
    return "No diagnostic returned"
  end
  value = string.gsub(value, string.char(13), " ")
  value = string.gsub(value, string.char(10), " ")
  if #value > 38 then value = string.sub(value, 1, 35) .. "..." end
  return value
end

local function format_record(text)
  text = string.gsub(text, string.char(13), " ")
  text = string.gsub(text, string.char(10), " ")
  if #text > MAX_RECORD_BYTES then
    text = string.sub(text, 1, MAX_RECORD_BYTES - 3) .. "..."
  end

  local lines = {}
  local start = 1
  while start <= #text do
    lines[#lines + 1] = string.sub(text, start, start + MAX_LINE_BYTES - 1)
    start = start + MAX_LINE_BYTES
  end
  return "NDEF TEXT:\n" .. table.concat(lines, "\n")
end

local function show_waiting()
  status_label:set_text("NO TAG")
  status_label:set_color(0x9ecbff)
  uid_label:set_text("Present an NFC tag")
  record_label:set_text("NDEF TEXT:\n(no tag)")
  detail_label:set_text("A clears the reader")
  set_led_mode("wait")
end

local function show_unavailable()
  status_label:set_text("NFC UNAVAILABLE")
  status_label:set_color(0xff6666)
  uid_label:set_text("Reader could not start")
  record_label:set_text("No tag can be read")
  detail_label:set_text("Check badge hardware/runtime")
  set_led_mode("error")
end

local function show_empty(uid, error_text)
  status_label:set_text(error_text and "READ FAILED" or "EMPTY TAG")
  status_label:set_color(0xff9966)
  uid_label:set_text("UID: " .. uid)
  record_label:set_text(error_text and "NDEF TEXT:\n(read error)" or
    "NDEF TEXT:\n(no Text record)")
  detail_label:set_text(error_text and clean_detail(error_text) or
    "No NDEF Text record found")
  set_led_mode("error", badge.sys.ms() + 900)
end

local function show_record(uid, text)
  status_label:set_text("TAG READ")
  status_label:set_color(0x66ee99)
  uid_label:set_text("UID: " .. uid)
  record_label:set_text(format_record(text))
  detail_label:set_text("First NDEF Text record")
  set_led_mode("success", badge.sys.ms() + 900)
end

local function poll_nfc(now)
  if not nfc_enabled or now < next_poll then return end
  next_poll = now + NFC_POLL_MS

  local card = badge.nfc.card()
  if clear_at ~= 0 and now >= clear_at and
      (not card or card.uid == seen_uid) then
    badge.nfc.clear()
    rearm_uid = seen_uid
    clear_at = 0
    return
  end
  if clear_at ~= 0 and now >= clear_at then
    clear_at = 0
  end

  if not card then
    if rearm_uid ~= nil then
      rearm_uid = nil
      seen_uid = nil
      show_waiting()
    end
    return
  end

  local uid = card.uid
  if type(uid) ~= "string" or #uid == 0 then
    show_empty("unknown", "Card UID unavailable")
    return
  end
  if rearm_uid ~= nil then
    if uid == rearm_uid then return end
    rearm_uid = nil
    seen_uid = nil
  end
  if uid == seen_uid then return end

  -- Mark the card before reading so failures are also debounced.
  seen_uid = uid
  clear_at = now + NFC_CLEAR_MS
  local text, error_text = badge.nfc.read_text()
  if type(text) ~= "string" then
    show_empty(uid, error_text)
  elseif #text == 0 then
    show_empty(uid, nil)
  else
    show_record(uid, text)
  end
end

function on_enter(root)
  local title = badge.ui.label(root, "NFC RECORD DISPLAY")
  title:align("top_mid", 0, 10)
  title:style({ text_font = 18 })

  status_label = badge.ui.label(root, "Starting NFC reader...")
  status_label:align("top_mid", 0, 42)
  status_label:style({ text_font = 20 })

  uid_label = badge.ui.label(root, "")
  uid_label:align("center", 0, -55)
  uid_label:style({ text_font = 14 })

  record_label = badge.ui.label(root, "")
  record_label:align("center", 0, -4)
  record_label:style({ text_font = 16, text_align = "center" })

  detail_label = badge.ui.label(root, "")
  detail_label:align("center", 0, 57)
  detail_label:style({ text_font = 14, text_color = 0xbfc7d5 })

  local hint = badge.ui.label(root, "A scan again   HOME exits")
  hint:align("bottom_mid", 0, -14)
  hint:style({ text_font = 14, text_color = 0xbfc7d5 })

  nfc_enabled = badge.nfc.enable() == true
  if nfc_enabled then
    badge.nfc.clear()
    show_waiting()
  else
    show_unavailable()
  end
end

function on_tick()
  local now = badge.sys.ms()
  poll_nfc(now)
  render_leds(now)
end

function on_button(button, kind)
  if kind ~= badge.input.KIND.PRESSED then return end
  if button == badge.input.BUTTON.A and nfc_enabled then
    badge.nfc.clear()
    seen_uid = nil
    rearm_uid = nil
    clear_at = 0
    show_waiting()
  end
end

function on_exit()
  if nfc_enabled then badge.nfc.disable() end
  badge.led.clear()
  badge.led.show()
end
