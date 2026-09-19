-- HTN26 Overcooked IRL player badge.
-- NFC text tags are local observations. Radio queueing is not server confirmation.

local MAX_RADIO_BYTES = 44
local MAX_TAG_BYTES = 28
local MAX_SEQUENCE = 999999999
local MAX_ATTEMPTS = 3
local RETRY_DELAY_MS = 300
local MAX_PENDING = 4
local NFC_POLL_MS = 180
local NFC_REARM_DELAY_MS = 900

-- These are the semantic NDEF Text values supported by this player app.
-- Delivery remains a gateway-badge action: the player brings the plate to it.
local SUPPORTED_TAGS = {
	["ING:TOMATO"] = "ING:TOM",
	["STATION:CHOP1"] = "STN:CHOP1",
	["STATION:POT1"] = "STN:POT1",
	["PLATE:1"] = "STN:PLATE",
	["STATION:DELIVERY"] = "STN:DELIVERY",
}

-- Pure protocol helpers. They have no badge or UI dependencies.
local function printable_ascii(value)
	if type(value) ~= "string" or #value == 0 then
		return false
	end
	for i = 1, #value do
		local byte = string.byte(value, i)
		if byte < 32 or byte > 126 or byte == 124 then
			return false
		end
	end
	return true
end

local function format_event(sequence, event_type, value)
	if type(sequence) ~= "number" or sequence < 1 or sequence > MAX_SEQUENCE or sequence ~= math.floor(sequence) then
		return nil, "bad-sequence"
	end
	if event_type ~= "N" or not printable_ascii(value) then
		return nil, "bad-field"
	end
	local payload = "OC1|" .. tostring(sequence) .. "|" .. event_type .. "|" .. value
	if #payload > MAX_RADIO_BYTES then
		return nil, "event-too-long"
	end
	return payload
end

local function parse_tag(text)
	if type(text) ~= "string" or #text == 0 then
		return nil, "no-text"
	end
	if #text > MAX_TAG_BYTES then
		return nil, "tag-too-long"
	end
	if not printable_ascii(text) then
		return nil, "malformed"
	end
	local name = SUPPORTED_TAGS[text]
	if not name then
		return nil, "unsupported"
	end
	return name
end

local function next_sequence_after(sequence)
	if sequence >= MAX_SEQUENCE then
		return nil
	end
	return sequence + 1
end

local function same_tag(uid, seen_uid)
	return uid ~= nil and uid ~= "" and uid == seen_uid
end

local nfc_enabled = false
local radio_enabled = false
local seen_uid = nil
local rearm_uid = nil
local rearm_at = 0
local next_nfc_poll = 0
local sequence = 0

local status_label
local detail_label
local last_label
local flow_label
local radio_label

local tx_current = nil
local tx_queue = {}
local tx_queue_count = 0

local led_mode = "search"
local led_mode_until = 0
local next_led_update = 0

local function set_led_mode(mode, until_ms)
	led_mode = mode
	led_mode_until = until_ms or 0
	next_led_update = 0
end

local function render_leds(now)
	if now < next_led_update and (led_mode_until == 0 or now < led_mode_until) then
		return
	end
	if led_mode_until ~= 0 and now >= led_mode_until then
		led_mode = "search"
		led_mode_until = 0
		next_led_update = 0
	end

	badge.led.clear()
	if led_mode == "search" then
		local index = math.floor(now / 150) % 6 + 1
		badge.led.set(index, 0, 0, 96)
	elseif led_mode == "capture" then
		local bright = math.floor(now / 100) % 2 == 0
		badge.led.set_all(0, bright and 190 or 70, bright and 50 or 20)
	elseif led_mode == "queued" then
		badge.led.set_all(0, 60, 180)
	elseif led_mode == "error" then
		local bright = math.floor(now / 120) % 2 == 0
		badge.led.set_all(bright and 220 or 90, 0, 0)
	end
	badge.led.show()
	next_led_update = now + 100
end

local function set_status(message, detail, color)
	status_label:set_text(message)
	status_label:set_color(color or 0xffffff)
	detail_label:set_text(detail)
end

local function show_ready()
	if nfc_enabled and radio_enabled then
		set_status("READY - SCAN TAG", "Local capture; radio queued only", 0x8ed8ff)
		radio_label:set_text("Radio ready - no server confirmation")
	elseif nfc_enabled then
		set_status("NFC READY", "Local capture only - radio unavailable", 0xffcc66)
		radio_label:set_text("Radio unavailable - nothing will be sent")
	elseif radio_enabled then
		set_status("NFC UNAVAILABLE", "Radio is ready, but no tag can be read", 0xff6666)
		radio_label:set_text("Radio ready - waiting for NFC")
	else
		set_status("NFC + RADIO OFF", "Hardware unavailable; no events sent", 0xff5555)
		radio_label:set_text("NFC and radio unavailable")
	end
	set_led_mode("search")
end

local function pending_count()
	return (tx_current and 1 or 0) + tx_queue_count
end

local function enqueue_event(entry)
	if pending_count() >= MAX_PENDING then
		return false
	end
	if not tx_current then
		tx_current = entry
	else
		tx_queue_count = tx_queue_count + 1
		tx_queue[tx_queue_count] = entry
	end
	return true
end

local function start_next_event()
	if tx_current or tx_queue_count == 0 then
		return
	end
	tx_current = tx_queue[1]
	for i = 1, tx_queue_count - 1 do
		tx_queue[i] = tx_queue[i + 1]
	end
	tx_queue[tx_queue_count] = nil
	tx_queue_count = tx_queue_count - 1
end

local function finish_current_event()
	tx_current = nil
	start_next_event()
end

local function service_radio(now)
	if not radio_enabled then
		return
	end
	start_next_event()
	if not tx_current or now < tx_current.next_attempt then
		return
	end

	local entry = tx_current
	entry.attempts = entry.attempts + 1
	local queued = badge.radio.send(entry.payload)
	if queued then
		entry.queued = entry.queued + 1
		set_led_mode("queued", now + 160)
		radio_label:set_text(
			"Seq "
				.. tostring(entry.sequence)
				.. " queued "
				.. tostring(entry.attempts)
				.. "/"
				.. tostring(MAX_ATTEMPTS)
				.. " - no ack"
		)
	else
		radio_label:set_text(
			"Seq " .. tostring(entry.sequence) .. " retry " .. tostring(entry.attempts) .. "/" .. tostring(MAX_ATTEMPTS)
		)
		set_led_mode("error", now + 180)
	end

	if entry.attempts >= MAX_ATTEMPTS then
		if entry.queued > 0 then
			set_status("LOCAL CAPTURED", "Attempts done - not server-confirmed", 0x8ed8ff)
		else
			set_status("LOCAL CAPTURED", "Radio send failed - not server-confirmed", 0xff9966)
		end
		finish_current_event()
	else
		entry.next_attempt = now + RETRY_DELAY_MS
		if queued then
			detail_label:set_text("Queued locally; retrying, no server ack")
		else
			detail_label:set_text("Radio unavailable for this try; retrying")
		end
	end
end

local function rejected_tag(reason)
	if reason == "tag-too-long" or reason == "event-too-long" then
		set_status("TAG TOO LONG", "Event must fit in 44 radio bytes", 0xff6666)
	elseif reason == "no-text" then
		set_status("TAG READ ERROR", "No NDEF Text record found", 0xff6666)
	elseif reason == "malformed" then
		set_status("MALFORMED TAG", "Use plain ASCII semantic tag text", 0xff6666)
	else
		set_status("UNSUPPORTED TAG", "Use TOMATO, CHOP1, POT1, or PLATE1", 0xffcc66)
	end
	last_label:set_text("Last: rejected (local only)")
	set_led_mode("error", badge.sys.ms() + 700)
end

local function capture_tag(text)
	local display_name, reason = parse_tag(text)
	if not display_name then
		rejected_tag(reason)
		return
	end

	last_label:set_text("Last: " .. display_name)
	set_led_mode("capture", badge.sys.ms() + 500)

	if not radio_enabled then
		set_status("LOCAL CAPTURED", "Radio unavailable - not sent", 0xffcc66)
		radio_label:set_text("No radio event for this tag")
		return
	end

	if pending_count() >= MAX_PENDING then
		set_status("RADIO BUSY", "Bounded queue full; tag not sent", 0xff6666)
		radio_label:set_text("Wait for queued events to finish")
		set_led_mode("error", badge.sys.ms() + 700)
		return
	end

	local next_sequence = next_sequence_after(sequence)
	if not next_sequence then
		set_status("SEQUENCE LIMIT", "No more events can be numbered", 0xff6666)
		radio_label:set_text("Restarting would risk duplicate sequence IDs")
		set_led_mode("error", badge.sys.ms() + 700)
		return
	end
	local payload, format_error = format_event(next_sequence, "N", display_name)
	if not payload then
		rejected_tag(format_error)
		return
	end

	sequence = next_sequence
	badge.store.set_int("seq", sequence)
	local entry = {
		payload = payload,
		sequence = sequence,
		attempts = 0,
		queued = 0,
		next_attempt = 0,
	}
	if not enqueue_event(entry) then
		set_status("RADIO BUSY", "Bounded queue full; tag not sent", 0xff6666)
		set_led_mode("error", badge.sys.ms() + 700)
		return
	end

	set_status("LOCAL CAPTURED", "Queued locally; not server-confirmed", 0x8ed8ff)
	radio_label:set_text(
		"Seq " .. tostring(sequence) .. " pending 0/" .. tostring(MAX_ATTEMPTS) .. " - same seq on retry"
	)
end

local function poll_nfc(now)
	if not nfc_enabled or now < next_nfc_poll then
		return
	end
	next_nfc_poll = now + NFC_POLL_MS

	local card = badge.nfc.card()
	if seen_uid and rearm_at ~= 0 and now >= rearm_at then
		badge.nfc.clear()
		rearm_uid = seen_uid
		rearm_at = 0
		return
	end
	if not card then
		if rearm_uid then
			rearm_uid = nil
			seen_uid = nil
		end
		return
	end
	local uid = card.uid
	if not uid or uid == "" then
		return
	end
	if rearm_uid then
		if uid == rearm_uid then
			return
		end
		rearm_uid = nil
		seen_uid = nil
	end
	if same_tag(uid, seen_uid) then
		return
	end

	-- Mark the UID before reading so a malformed tag is debounced too.
	seen_uid = uid
	rearm_at = now + NFC_REARM_DELAY_MS
	local text = badge.nfc.read_text()
	capture_tag(text)
end

function on_enter(root)
	local title = badge.ui.label(root, "HTN26 PLAYER BADGE")
	title:align("top_mid", 0, 10)
	title:style({ text_font = 18, text_color = 0xffffff })

	status_label = badge.ui.label(root, "Starting NFC + radio...")
	status_label:align("top_mid", 0, 43)
	status_label:style({ text_font = 20 })

	detail_label = badge.ui.label(root, "Local feedback only")
	detail_label:align("center", 0, -18)
	detail_label:style({ text_font = 14 })

	last_label = badge.ui.label(root, "Last: none")
	last_label:align("center", 0, 7)
	last_label:style({ text_font = 14 })

	flow_label = badge.ui.label(root, "Flow: TOMATO > CHOP > POT > PLATE")
	flow_label:align("center", 0, 32)
	flow_label:style({ text_font = 14, text_color = 0xbfc7d5 })

	radio_label = badge.ui.label(root, "Starting restricted radio...")
	radio_label:align("center", 0, 57)
	radio_label:style({ text_font = 14 })

	local hint = badge.ui.label(root, "A re-scan   HOME exit")
	hint:align("bottom_mid", 0, -14)
	hint:style({ text_font = 14, text_color = 0xbfc7d5 })

	sequence = badge.store.get_int("seq", 0)
	if type(sequence) ~= "number" or sequence < 0 or sequence > MAX_SEQUENCE then
		sequence = 0
	else
		sequence = math.floor(sequence)
	end

	nfc_enabled = badge.nfc.enable()
	if nfc_enabled then
		badge.nfc.clear()
	end

	radio_enabled = badge.radio.enable()
	if radio_enabled then
		badge.radio.on_recv(nil)
	end

	show_ready()
end

function on_tick()
	local now = badge.sys.ms()
	poll_nfc(now)
	service_radio(now)
	render_leds(now)
end

function on_button(button, kind)
	if kind ~= badge.input.KIND.PRESSED then
		return
	end
	if button ~= badge.input.BUTTON.A then
		return
	end

	if nfc_enabled then
		badge.nfc.clear()
		seen_uid = nil
		rearm_uid = nil
		rearm_at = 0
	end
	show_ready()
end

function on_exit()
	if radio_enabled then
		badge.radio.on_recv(nil)
		badge.radio.disable()
	end
	if nfc_enabled then
		badge.nfc.disable()
	end
	badge.led.clear()
	badge.led.show()
end
