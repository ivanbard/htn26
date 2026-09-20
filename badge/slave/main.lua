-- HTN26 Player Badge. This file is self-contained: it has no require() dependencies.
-- Pair it with manifest.cfg when using the IDE's two-file workspace.

local RADIO_BYTES = 44
local MAX_SEQUENCE = 999999
local MAX_RADIO_QUEUE = 8
local MAX_RADIO_DRAIN = 4
local NFC_POLL_MS = 150
local NFC_CLEAR_MS = 500
local CHOP_MS = 3000
local READY_MS = 500
local TRANSFER_MS = 800
local COOK_MS = 15000
local DONE_MS = 2000
local WARNING_MS = 3000

local ITEMS = {
	BUN = true,
	RAW_MEAT = true,
	CHOPPED_MEAT = true,
	MEAT = true,
	RAW_LETTUCE = true,
	LETTUCE = true,
	RAW_CHEESE = true,
	CHEESE = true,
	BURNT = true,
}

local ITEM_SHORT = {
	BUN = "B",
	RAW_MEAT = "R",
	CHOPPED_MEAT = "D",
	MEAT = "M",
	BURNT = "X",
	RAW_LETTUCE = "Q",
	LETTUCE = "L",
	RAW_CHEESE = "K",
	CHEESE = "C",
}

local SHORT_ITEM = {
	B = "BUN",
	R = "RAW_MEAT",
	D = "CHOPPED_MEAT",
	M = "MEAT",
	X = "BURNT",
	Q = "RAW_LETTUCE",
	L = "LETTUCE",
	K = "RAW_CHEESE",
	C = "CHEESE",
}

local SOURCE_TAGS = {
	["pantry"] = true,
	["fridge"] = true,
	["cutting board"] = true,
	["stove"] = true,
}

local function is_platable(item)
	return item == "BUN" or item == "MEAT" or item == "LETTUCE" or item == "CHEESE"
end

local function plate_letter(item)
	if item == "BUN" then
		return "B"
	end
	if item == "MEAT" then
		return "M"
	end
	if item == "LETTUCE" then
		return "L"
	end
	if item == "CHEESE" then
		return "C"
	end
	return nil
end

local function new_plate()
	return { B = false, M = false, L = false, C = false }
end

local function plate_summary(plate)
	if not plate then
		return "----"
	end
	return (plate.B and "B" or "-") .. (plate.M and "M" or "-") .. (plate.L and "L" or "-") .. (plate.C and "C" or "-")
end

local function plate_from_summary(value)
	if type(value) ~= "string" or #value ~= 4 then
		return nil
	end
	local plate = new_plate()
	local letters = { "B", "M", "L", "C" }
	for i = 1, 4 do
		local c = string.sub(value, i, i)
		if c ~= "-" and c ~= letters[i] then
			return nil
		end
		if c ~= "-" then
			plate[c] = true
		end
	end
	return plate
end

local function new_state()
	return {
		hand = nil,
		plate = nil,
		chop = nil,
		stoves = {
			{ item = nil, started = 0 },
			{ item = nil, started = 0 },
		},
	}
end

local function has_held_state(state)
	return state.hand ~= nil or state.plate ~= nil or state.chop ~= nil
end

local function take_source(state, item)
	if not ITEMS[item] then
		return false, "BAD_ITEM"
	end
	if state.chop then
		return false, "CHOPPING"
	end
	if state.plate then
		if not is_platable(item) then
			return false, "NOT_PLATABLE"
		end
		local letter = plate_letter(item)
		if state.plate[letter] then
			return false, "DUPLICATE"
		end
		state.plate[letter] = true
		return true, "PLATE_ADD"
	end
	if state.hand then
		return false, "HAND_FULL"
	end
	state.hand = item
	return true, "PICKUP"
end

local function create_plate(state)
	if state.chop or state.plate then
		return false, "PLATE_ALREADY_HELD"
	end
	if state.hand then
		if not is_platable(state.hand) then
			return false, "NOT_PLATABLE"
		end
		local plate = new_plate()
		plate[plate_letter(state.hand)] = true
		state.plate, state.hand = plate, nil
		return true, "PLATE_ADD"
	end
	state.plate = new_plate()
	return true, "PLATE_NEW"
end

local function add_to_plate(state, item)
	if not state.plate then
		return false, "NO_PLATE"
	end
	return take_source(state, item)
end

local function discard_state(state)
	local had = has_held_state(state)
	state.hand, state.plate, state.chop = nil, nil, nil
	return had
end

local function start_chop(state, now)
	if state.chop then
		return false, "CHOPPING"
	end
	if state.hand ~= "RAW_MEAT" and state.hand ~= "RAW_LETTUCE" and state.hand ~= "RAW_CHEESE" then
		return false, "NOT_CUTTABLE"
	end
	state.chop = { item = state.hand, started = now, step = 0 }
	state.hand = nil
	return true, "CHOP_START"
end

local function chop_step(state, now)
	if not state.chop then
		return 0
	end
	local elapsed = math.max(0, now - state.chop.started)
	return math.min(6, math.floor(elapsed * 6 / CHOP_MS))
end

local function finish_chop(state, now)
	if not state.chop or now - state.chop.started < CHOP_MS then
		return false, "NOT_DONE"
	end
	local item = state.chop.item
	if item == "RAW_MEAT" then
		state.hand = "CHOPPED_MEAT"
	elseif item == "RAW_LETTUCE" then
		state.hand = "LETTUCE"
	elseif item == "RAW_CHEESE" then
		state.hand = "CHEESE"
	else
		return false, "BAD_CHOP"
	end
	state.chop = nil
	return true, "CHOP_DONE"
end

local function fail_chop(state)
	if not state.chop then
		return false, "NO_CHOP"
	end
	state.hand = state.chop.item
	state.chop = nil
	return true, "CHOP_FAIL"
end

local function stove_phase(stove, now)
	if not stove or not stove.item then
		return "EMPTY", 0
	end
	local elapsed = math.max(0, now - stove.started)
	if elapsed < COOK_MS then
		return "COOKING", math.floor(elapsed * 6 / COOK_MS)
	end
	if elapsed < COOK_MS + DONE_MS then
		return "DONE", 6
	end
	if elapsed < COOK_MS + DONE_MS + WARNING_MS then
		return "WARNING", 6
	end
	return "BURNT", 6
end

local function stove_action(state, index, now)
	if index ~= 1 and index ~= 2 then
		return false, "BAD_STOVE"
	end
	if state.chop then
		return false, "CHOPPING"
	end
	local stove = state.stoves[index]
	local phase = stove_phase(stove, now)
	if state.hand == "CHOPPED_MEAT" and phase == "EMPTY" then
		stove.item, stove.started = "CHOPPED_MEAT", now
		state.hand = nil
		return true, "PUT"
	end
	if not state.hand and phase ~= "EMPTY" then
		if phase == "COOKING" then
			return false, "NOT_DONE"
		end
		state.hand = phase == "BURNT" and "BURNT" or "MEAT"
		stove.item, stove.started = nil, 0
		return true, phase == "BURNT" and "TAKE_BURNT" or "TAKE"
	end
	if phase == "EMPTY" then
		return false, "EMPTY_STOVE"
	end
	if state.hand then
		return false, "HAND_FULL"
	end
	return false, "NOT_DONE"
end

local function apply_peer_stove(state, action, now)
	local side, operation = string.match(action or "", "^ST:([LR]):([PTX])$")
	if not side then
		return false
	end
	local stove = state.stoves[side == "L" and 1 or 2]
	if operation == "P" then
		if stove.item then
			return false
		end
		-- The placement broadcast is the shared clock edge. Every listening badge
		-- records its local receipt time and advances doneness without querying the host.
		stove.item, stove.started = "CHOPPED_MEAT", now
	else
		stove.item, stove.started = nil, 0
	end
	return true
end

local function snapshot(state)
	if state.plate then
		return "P" .. plate_summary(state.plate)
	end
	if state.hand then
		return "H" .. (ITEM_SHORT[state.hand] or "?")
	end
	if state.chop then
		return "H" .. (ITEM_SHORT[state.chop.item] or "?")
	end
	return "E----"
end

local function parse_snapshot(value)
	if type(value) ~= "string" then
		return nil
	end
	local kind = string.sub(value, 1, 1)
	if kind == "P" then
		local plate = plate_from_summary(string.sub(value, 2, 5))
		if plate then
			return { plate = plate, hand = nil }
		end
	elseif kind == "H" then
		local item = SHORT_ITEM[string.sub(value, 2, 2)]
		if item then
			return { plate = nil, hand = item }
		end
	elseif value == "E----" then
		return { plate = nil, hand = nil }
	end
	return nil
end

-- Each badge sees the other badge's original snapshot. When both badges have
-- tapped, applying this function on both sides swaps or merges deterministically.
local function apply_transfer(state, peer)
	if not peer then
		return false, "BAD_SNAPSHOT"
	end
	local local_plate, peer_plate = state.plate ~= nil, peer.plate ~= nil
	if local_plate and peer_plate then
		state.plate, state.hand = peer.plate, nil
		return true, "SWAP_PLATES"
	end
	if local_plate and not peer_plate then
		if peer.hand and is_platable(peer.hand) then
			local letter = plate_letter(peer.hand)
			if not state.plate[letter] then
				state.plate[letter] = true
				return true, "MERGE_IN"
			end
		end
		if peer.hand then
			state.plate, state.hand = nil, peer.hand
			return true, "SWAP_HANDS"
		end
		return false, "NO_PEER_ITEM"
	end
	if not local_plate and peer_plate then
		if state.hand and is_platable(state.hand) then
			local letter = plate_letter(state.hand)
			if not peer.plate[letter] then
				state.hand = nil
				return true, "MERGE_OUT"
			end
		end
		if state.hand then
			state.plate, state.hand = peer.plate, nil
			return true, "SWAP_HANDS"
		end
		return false, "NO_LOCAL_ITEM"
	end
	state.hand = peer.hand
	return true, "SWAP_HANDS"
end

local function printable_action(value)
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

local function event_payload(sequence, player, action)
	if type(sequence) ~= "number" or sequence < 1 or sequence > MAX_SEQUENCE or sequence ~= math.floor(sequence) then
		return nil, "BAD_SEQUENCE"
	end
	if player ~= 1 and player ~= 2 and player ~= 3 then
		return nil, "BAD_PLAYER"
	end
	if not printable_action(action) then
		return nil, "BAD_ACTION"
	end
	local payload = string.format("OC2|%06d|E|P%d:%s", sequence, player, action)
	if #payload > RADIO_BYTES then
		return nil, "TOO_LONG"
	end
	return payload
end

local function parse_event(payload)
	if type(payload) ~= "string" or #payload > RADIO_BYTES then
		return nil
	end
	local sequence, player, action = string.match(payload, "^OC2|(%d+)|E|P([1-3]):(.+)$")
	if not sequence then
		return nil
	end
	sequence, player = tonumber(sequence), tonumber(player)
	if not sequence or sequence < 1 or not printable_action(action) then
		return nil
	end
	return sequence, player, action
end

local function parse_control(payload)
	if type(payload) ~= "string" or #payload > RADIO_BYTES then
		return nil
	end
	local sequence, code = string.match(payload, "^OC2|(%d+)|G|([SE])$")
	if sequence then
		return tonumber(sequence), code
	end
	sequence, code = string.match(payload, "^OC2|(%d+)|G|(START)$")
	if sequence then
		return tonumber(sequence), "S"
	end
	sequence = string.match(payload, "^OC2|(%d+)|G|(END)$")
	if sequence then
		return tonumber(sequence), "E"
	end
	return nil
end

local function resolve_tag_action(tag, left, right, down, a)
	if not SOURCE_TAGS[tag] then
		return nil, "UNKNOWN_TAG"
	end
	if tag == "pantry" then
		if down then
			return "PLATE", nil
		end
		if left then
			return "LETTUCE", nil
		end
		if right then
			return "BUN", nil
		end
		return nil, "UNKNOWN_BUTTON_COMBO"
	end
	if tag == "fridge" then
		if left then
			return "RAW_MEAT", nil
		end
		if right then
			return "RAW_CHEESE", nil
		end
		return nil, "UNKNOWN_BUTTON_COMBO"
	end
	if tag == "cutting board" then
		if a then
			return "CHOP", nil
		end
		return nil, "UNKNOWN_BUTTON_COMBO"
	end
	if tag == "stove" then
		if left then
			return "STOVE_LEFT", nil
		end
		if right then
			return "STOVE_RIGHT", nil
		end
		return nil, "UNKNOWN_BUTTON_COMBO"
	end
end

-- Runtime state. It is intentionally local to this badge; the Pi remains the
-- order/score authority and is only given the compact event stream.
local player_no = 0
local sequence = 0
local active = false
local setup_mode = false
local state = new_state()
local a_down, b_down, left_down, right_down, down_down = false, false, false, false, false
local nfc_enabled, radio_enabled = false, false
local nfc_blocked_uid, nfc_clear_at, next_nfc_poll = nil, 0, 0
local inbox, inbox_count, radio_drop_count = {}, 0, 0
local last_peer_sequence = { 0, 0, 0 }
local latest_control_sequence = 0
local ready_until = { 0, 0, 0 }
local submit_record = nil
local submission_committed = false
local transfer_until = 0
local last_chop_step = -1

local title_label, game_label, held_label, plate_label
local chop_label, stove_label, status_label, radio_label
local status_color = 0xffffff
local led_mode, led_until, next_led = "idle", 0, 0

local function set_status(message, detail, color)
	if status_label then
		status_label:set_text(message)
		status_label:set_color(color or 0xffffff)
	end
	if detail and radio_label then
		radio_label:set_text(detail)
	end
	status_color = color or 0xffffff
	led_mode, led_until, next_led = (color == 0xff5555 and "error" or "event"), badge.sys.ms() + 650, 0
end

local function clear_submission()
	ready_until = { 0, 0, 0 }
	submit_record = nil
	submission_committed = false
end

local function reset_local_state()
	state = new_state()
	clear_submission()
	transfer_until = 0
	last_chop_step = -1
end

local function accept_control_sequence(control_sequence)
	if type(control_sequence) ~= "number" or control_sequence <= latest_control_sequence then
		return false
	end
	latest_control_sequence = control_sequence
	return true
end

local function render_state(now)
	if not title_label then
		return
	end
	if setup_mode then
		game_label:set_text("FIXED PLAYER SETUP")
		held_label:set_text("Player number: " .. tostring(player_no))
		plate_label:set_text("LEFT/RIGHT choose   A save")
		chop_label:set_text("No late joins")
		stove_label:set_text("Assign 1, 2, or 3 before play")
		return
	end
	game_label:set_text("PLAYER " .. tostring(player_no) .. "  " .. (active and "GAME ON" or "WAIT START"))
	local held = state.chop and "CHOPPING" or (state.hand or "EMPTY")
	held_label:set_text("Hand: " .. held)
	plate_label:set_text("Plate: " .. (state.plate and plate_summary(state.plate) or "NONE"))
	if state.chop then
		local step = chop_step(state, now)
		chop_label:set_text("Cutting: " .. tostring(step) .. "/6  hold A")
	else
		chop_label:set_text("Cutting: idle")
	end
	local left_phase, left_step = stove_phase(state.stoves[1], now)
	local right_phase, right_step = stove_phase(state.stoves[2], now)
	stove_label:set_text(
		"Stoves L "
			.. left_phase
			.. " "
			.. tostring(left_step)
			.. "/6  R "
			.. right_phase
			.. " "
			.. tostring(right_step)
			.. "/6"
	)
end

local function render_leds(now)
	if now < next_led then
		return
	end
	next_led = now + 100
	badge.led.clear()
	if setup_mode or not active then
		if math.floor(now / 400) % 2 == 0 then
			badge.led.set_all(0, 35, 100)
		end
	elseif led_mode == "error" and now < led_until then
		if math.floor(now / 120) % 2 == 0 then
			badge.led.set_all(220, 0, 0)
		end
	elseif state.chop then
		local step = chop_step(state, now)
		for i = 1, step do
			badge.led.set(i, 220, 150, 0)
		end
	elseif led_mode == "event" and now < led_until then
		badge.led.set_all(0, 150, 60)
	else
		if player_no == 1 then
			badge.led.set_all(80, 0, 80)
		elseif player_no == 2 then
			badge.led.set_all(0, 80, 50)
		else
			badge.led.set_all(0, 45, 120)
		end
		local phase = stove_phase(state.stoves[1], now)
		if phase == "WARNING" or stove_phase(state.stoves[2], now) == "WARNING" then
			if math.floor(now / 180) % 2 == 0 then
				badge.led.set_all(220, 30, 0)
			end
		end
	end
	badge.led.show()
end

local function next_sequence()
	if sequence >= MAX_SEQUENCE then
		return nil
	end
	sequence = sequence + 1
	badge.store.set_int("seq", sequence)
	return sequence
end

local function emit(action)
	if not radio_enabled or player_no < 1 or player_no > 3 then
		return false
	end
	local number = next_sequence()
	if not number then
		set_status("SEQUENCE LIMIT", "Reopen only after provisioning a new badge", 0xff5555)
		return false
	end
	local payload = event_payload(number, player_no, action)
	if not payload then
		return false
	end
	local queued = badge.radio.send(payload)
	if not queued then
		set_status("RADIO SEND FAILED", "Local state changed; event was not queued", 0xff5555)
	end
	return queued
end

local function show_invalid(reason)
	if reason == "DUPLICATE" then
		set_status("DUPLICATE ITEM", "That ingredient is already on the plate", 0xff5555)
	elseif reason == "HAND_FULL" then
		set_status("HAND FULL", "Drop, plate, transfer, or use the item", 0xff5555)
	elseif reason == "NOT_PLATABLE" then
		set_status("NOT PLATABLE", "Cut it first; raw food cannot go on a plate", 0xff5555)
	elseif reason == "NOT_DONE" then
		set_status("STILL COOKING", "Wait for DONE, then scan stove again", 0xffcc66)
	elseif reason == "EMPTY_STOVE" then
		set_status("EMPTY STOVE", "Put cut meat on this stove first", 0xffcc66)
	else
		set_status("UNKNOWN BUTTON COMBO", "Hold the documented button while scanning", 0xff5555)
	end
end

local function start_game(control_sequence, code)
	if setup_mode then
		set_status("PLAYER NOT SAVED", "Choose 1, 2, or 3 and press A before start", 0xffcc66)
		return
	end
	if not accept_control_sequence(control_sequence) then
		return
	end
	active = true
	reset_local_state()
	set_status("GAME STARTED", "State cleared; waiting for pantry or fridge", 0x8ed8ff)
	emit("READY")
end

local function end_game(control_sequence, code)
	if not accept_control_sequence(control_sequence) then
		return
	end
	active = false
	reset_local_state()
	set_status("GAME ENDED", "All held items, plates, and timers discarded", 0xffcc66)
end

local function mark_ready(number, now)
	if number >= 1 and number <= 3 then
		ready_until[number] = now + READY_MS
	end
end

local function all_players_ready(values, now)
	for i = 1, 3 do
		if not values[i] or values[i] < now then
			return false
		end
	end
	return true
end

local function maybe_commit_submission(now)
	if not active or not submit_record or submission_committed or now > submit_record.deadline then
		return
	end
	if not all_players_ready(ready_until, now) then
		return
	end
	submission_committed = true
	discard_state(state)
	set_status("THREE READY - CLEARED", "Every fixed player discarded held state", 0x66ff88)
end

local function handle_peer_event(sequence_number, number, action, now)
	if number == player_no or number < 1 or number > 3 then
		return
	end
	if sequence_number <= (last_peer_sequence[number] or 0) then
		return
	end
	last_peer_sequence[number] = sequence_number
	if not active then
		return
	end

	if action == "READY" then
		mark_ready(number, now)
		set_status("PLAYER " .. tostring(number) .. " READY", "Shake window is 0.5 seconds", 0x8ed8ff)
	else
		local summary = string.match(action, "^SUB:([BMLC%-]+)$")
		if summary and #summary == 4 then
			if not submit_record then
				submit_record = { player = number, summary = summary, deadline = now + READY_MS }
			end
			mark_ready(number, now)
			set_status("SUBMIT FROM PLAYER " .. tostring(number), "Waiting for all 3 shakes", 0x8ed8ff)
		else
			local transfer_value = string.match(action, "^X:(.+)$")
			if transfer_value and now <= transfer_until then
				local peer = parse_snapshot(transfer_value)
				if peer then
					local changed = apply_transfer(state, peer)
					if changed then
						set_status("TAP TRANSFER", "Local plate/item state exchanged", 0x8ed8ff)
						led_mode, led_until, next_led = "event", now + 500, 0
					end
				end
			elseif apply_peer_stove(state, action, now) then
				set_status("STOVE SYNC", "Shared cooking clock updated from player " .. tostring(number), 0x8ed8ff)
			end
		end
	end
end

local function handle_radio_payload(payload, now)
	local control_sequence, code = parse_control(payload)
	if control_sequence and (code == "S" or code == "E") then
		if code == "S" then
			start_game(control_sequence, code)
		else
			end_game(control_sequence, code)
		end
		return
	end
	local sequence_number, number, action = parse_event(payload)
	if sequence_number then
		handle_peer_event(sequence_number, number, action, now)
	end
end

local function handle_drop(now)
	if not active then
		return
	end
	local dropped = snapshot(state)
	if discard_state(state) then
		emit("DROP:" .. dropped)
		set_status("DROPPED", "Held item or plate discarded", 0xffcc66)
	else
		show_invalid("EMPTY_STOVE")
	end
end

local function begin_transfer(now)
	if not active or state.chop then
		return
	end
	transfer_until = now + TRANSFER_MS
	emit("X:" .. snapshot(state))
	set_status("TRANSFER READY", "Tap the other badge; A + bump is fallback", 0x8ed8ff)
end

local function submit_shake(now)
	if not active then
		return
	end
	if not state.plate then
		begin_transfer(now)
		return
	end
	local summary = plate_summary(state.plate)
	mark_ready(player_no, now)
	submit_record = { player = player_no, summary = summary, deadline = now + READY_MS }
	discard_state(state)
	emit("SUB:" .. summary)
	set_status("PLATE SUBMITTED", "Plate consumed; waiting for 3 shakes", 0x8ed8ff)
end

local function ready_shake(now)
	if not active then
		return
	end
	mark_ready(player_no, now)
	emit("READY")
	set_status("READY SHAKE", "Other fixed players must shake now", 0x8ed8ff)
end

local function handle_shake(now)
	if b_down then
		handle_drop(now)
	elseif a_down then
		if state.plate then
			submit_shake(now)
		else
			begin_transfer(now)
		end
	else
		ready_shake(now)
	end
end

local function handle_tap(now)
	if active then
		begin_transfer(now)
	end
end

local function handle_pantry(now)
	local choice, reason = resolve_tag_action("pantry", left_down, right_down, down_down, a_down)
	if not choice then
		show_invalid(reason)
		return
	end
	if choice == "PLATE" then
		local ok, result = create_plate(state)
		if not ok then
			show_invalid(result)
			return
		end
		emit(result == "PLATE_NEW" and "PL:NEW" or "PL:" .. plate_summary(state.plate))
		set_status("PLATE HELD", "Add cut food with LEFT/RIGHT source scans", 0x8ed8ff)
	else
		local item = choice == "BUN" and "BUN" or "RAW_LETTUCE"
		local ok, result = take_source(state, item)
		if not ok then
			show_invalid(result)
			return
		end
		if result == "PLATE_ADD" then
			emit("PL:" .. plate_summary(state.plate))
		else
			emit("PU:" .. ITEM_SHORT[item])
		end
		set_status(
			result == "PLATE_ADD" and "ADDED TO PLATE" or "PICKED UP " .. item,
			"Local capture; Pi receives the event stream",
			0x8ed8ff
		)
	end
end

local function handle_fridge(now)
	local choice, reason = resolve_tag_action("fridge", left_down, right_down, down_down, a_down)
	if not choice then
		show_invalid(reason)
		return
	end
	local item = choice == "RAW_MEAT" and "RAW_MEAT" or "RAW_CHEESE"
	local ok, result = take_source(state, item)
	if not ok then
		show_invalid(result)
		return
	end
	if result == "PLATE_ADD" then
		emit("PL:" .. plate_summary(state.plate))
	else
		emit("PU:" .. ITEM_SHORT[item])
	end
	set_status(
		result == "PLATE_ADD" and "ADDED TO PLATE" or "PICKED UP " .. item,
		"Local capture; Pi receives the event stream",
		0x8ed8ff
	)
end

local function handle_cutting_board(now)
	local choice, reason = resolve_tag_action("cutting board", left_down, right_down, down_down, a_down)
	if choice ~= "CHOP" then
		show_invalid(reason)
		return
	end
	local ok, result = start_chop(state, now)
	if not ok then
		show_invalid(result)
		return
	end
	emit("CH:S")
	set_status("CHOPPING", "Hold A; release early to lose progress", 0xffcc66)
end

local function handle_stove(now)
	local choice, reason = resolve_tag_action("stove", left_down, right_down, down_down, a_down)
	if not choice then
		show_invalid(reason)
		return
	end
	local index = choice == "STOVE_LEFT" and 1 or 2
	local stove = state.stoves[index]
	local phase, step = stove_phase(stove, now)
	local ok, result = stove_action(state, index, now)
	if not ok then
		emit("ST:" .. (index == 1 and "L" or "R") .. ":C:" .. phase)
		show_invalid(result)
		return
	end
	local side = index == 1 and "L" or "R"
	if result == "PUT" then
		emit("ST:" .. side .. ":P")
	elseif result == "TAKE_BURNT" then
		emit("ST:" .. side .. ":X")
	else
		emit("ST:" .. side .. ":T")
	end
	set_status(
		result == "PUT" and "MEAT ON STOVE " .. side
			or (result == "TAKE_BURNT" and "BURNT MEAT - DROP IT" or "COOKED MEAT TAKEN"),
		"Stove " .. side .. " " .. phase .. " " .. tostring(step) .. "/6",
		0x8ed8ff
	)
end

local function handle_tag(text, now)
	if not active then
		set_status("WAITING FOR START", "Host controls start/end; no late joins", 0xffcc66)
		return
	end
	if text == "pantry" then
		handle_pantry(now)
	elseif text == "fridge" then
		handle_fridge(now)
	elseif text == "cutting board" then
		handle_cutting_board(now)
	elseif text == "stove" then
		handle_stove(now)
	else
		show_invalid("UNKNOWN_TAG")
	end
end

local function poll_nfc(now)
	if not nfc_enabled or now < next_nfc_poll then
		return
	end
	next_nfc_poll = now + NFC_POLL_MS
	local card = badge.nfc.card()
	if not card or type(card.uid) ~= "string" or card.uid == "" then
		nfc_blocked_uid = nil
		return
	end
	if nfc_blocked_uid == card.uid then
		return
	end
	nfc_blocked_uid = card.uid
	nfc_clear_at = now + NFC_CLEAR_MS
	handle_tag(badge.nfc.read_text(), now)
end

local function service_radio(now)
	local drained = 0
	while drained < MAX_RADIO_DRAIN and inbox_count > 0 do
		local payload = inbox[1]
		for i = 1, inbox_count - 1 do
			inbox[i] = inbox[i + 1]
		end
		inbox[inbox_count], inbox_count = nil, inbox_count - 1
		handle_radio_payload(payload, now)
		drained = drained + 1
	end
end

local function service_chop(now)
	if not state.chop then
		return
	end
	if not a_down then
		local ok = fail_chop(state)
		if ok then
			emit("CH:F")
			set_status("CUT FAILED", "A was released before all 6 steps", 0xff5555)
		end
		return
	end
	local step = chop_step(state, now)
	if step ~= last_chop_step then
		last_chop_step = step
		set_status("CHOPPING " .. tostring(step) .. "/6", "Hold A to finish", 0xffcc66)
	end
	if step >= 6 then
		local ok = finish_chop(state, now)
		if ok then
			emit("CH:D:" .. ITEM_SHORT[state.hand])
			set_status("CHOP DONE", "Now add the sliced item to a plate", 0x8ed8ff)
		end
	end
end

local function provision_player()
	player_no = badge.store.get_int("player_no", 0)
	if type(player_no) ~= "number" or player_no < 1 or player_no > 3 then
		player_no = 1
	end
	player_no = math.floor(player_no)
	setup_mode = badge.store.get_int("configured", 0) ~= 1
end

function on_enter(root)
	title_label = badge.ui.label(root, "HTN26 PLAYER BADGE")
	title_label:align("top_mid", 0, 7)
	title_label:style({ text_font = 18 })
	game_label = badge.ui.label(root, "Starting...")
	game_label:align("top_mid", 0, 31)
	game_label:style({ text_font = 14 })
	held_label = badge.ui.label(root, "Hand: EMPTY")
	held_label:align("top_mid", 0, 53)
	plate_label = badge.ui.label(root, "Plate: NONE")
	plate_label:align("top_mid", 0, 73)
	chop_label = badge.ui.label(root, "Cutting: idle")
	chop_label:align("top_mid", 0, 93)
	stove_label = badge.ui.label(root, "Stoves L EMPTY 0/6  R EMPTY 0/6")
	stove_label:align("top_mid", 0, 113)
	status_label = badge.ui.label(root, "Starting NFC + radio...")
	status_label:align("center", 0, 17)
	status_label:style({ text_font = 18, text_align = "center" })
	radio_label = badge.ui.label(root, "No host response is required")
	radio_label:align("center", 0, 48)
	radio_label:style({ text_font = 14, text_align = "center" })
	local hint = badge.ui.label(root, "TAP transfer  A+bump fallback  A+shake submit")
	hint:align("bottom_mid", 0, -10)
	hint:style({ text_font = 14, text_align = "center" })

	provision_player()
	sequence = badge.store.get_int("seq", 0)
	if type(sequence) ~= "number" or sequence < 0 or sequence > MAX_SEQUENCE then
		sequence = 0
	end
	sequence = math.floor(sequence)
	state = new_state()
	nfc_enabled = badge.nfc.enable() == true
	if nfc_enabled then
		badge.nfc.clear()
	end
	radio_enabled = badge.radio.enable() == true
	if radio_enabled then
		badge.radio.on_recv(function(mac, rssi, payload)
			if type(payload) == "string" and #payload <= RADIO_BYTES then
				if inbox_count < MAX_RADIO_QUEUE then
					inbox_count = inbox_count + 1
					inbox[inbox_count] = payload
				else
					radio_drop_count = radio_drop_count + 1
				end
			end
		end)
	end
	if setup_mode then
		set_status("CHOOSE PLAYER 1", "LEFT/RIGHT choose; A saves fixed number", 0x8ed8ff)
	elseif radio_enabled then
		set_status("WAITING FOR GAME START", "Fixed player " .. tostring(player_no) .. "; no late joins", 0x8ed8ff)
	else
		set_status("RADIO UNAVAILABLE", "NFC/local state still works; no event sent", 0xff5555)
	end
	render_state(badge.sys.ms())
	render_leds(badge.sys.ms())
end

function on_button(button, kind)
	local B = badge.input.BUTTON
	local K = badge.input.KIND
	if kind == K.PRESSED then
		if button == B.LEFT then
			left_down = true
		elseif button == B.RIGHT then
			right_down = true
		elseif button == B.DOWN then
			down_down = true
		elseif button == B.A then
			a_down = true
			if setup_mode then
				badge.store.set_int("player_no", player_no)
				badge.store.set_int("configured", 1)
				setup_mode = false
				set_status("PLAYER " .. tostring(player_no) .. " SAVED", "Waiting for host GAME START", 0x8ed8ff)
			end
		elseif button == B.B then
			b_down = true
		elseif button == B.START and not active then
			setup_mode = true
			set_status("CHOOSE PLAYER " .. tostring(player_no), "LEFT/RIGHT choose; A saves fixed number", 0x8ed8ff)
		end
	elseif kind == K.RELEASED then
		if button == B.LEFT then
			left_down = false
		elseif button == B.RIGHT then
			right_down = false
		elseif button == B.DOWN then
			down_down = false
		elseif button == B.A then
			if state.chop and a_down then
				local ok = fail_chop(state)
				if ok then
					emit("CH:F")
					set_status("CUT FAILED", "A was released before all 6 steps", 0xff5555)
				end
			end
			a_down = false
		elseif button == B.B then
			b_down = false
		end
	end
	if setup_mode and kind == K.PRESSED then
		if button == B.LEFT then
			player_no = (player_no + 1) % 3 + 1
		elseif button == B.RIGHT then
			player_no = player_no % 3 + 1
		end
		set_status("CHOOSE PLAYER " .. tostring(player_no), "LEFT/RIGHT choose; A saves fixed number", 0x8ed8ff)
	end
end

function on_tick_sensor()
	-- Kept separate so tests can call the gesture path without faking NFC.
end

function on_exit()
	if radio_enabled then
		badge.radio.on_recv(nil)
		badge.radio.disable()
		radio_enabled = false
	end
	if nfc_enabled then
		badge.nfc.disable()
		nfc_enabled = false
	end
	badge.led.clear()
	badge.led.show()
end

-- Gesture reads are cached sensor APIs, so they are sampled once per tick.
function on_tick()
	local now = badge.sys.ms()
	service_radio(now)
	if nfc_clear_at ~= 0 and now >= nfc_clear_at then
		badge.nfc.clear()
		nfc_clear_at = 0
	end
	poll_nfc(now)
	service_chop(now)
	if active then
		if badge.sensor.tap() then
			handle_tap(now)
		end
		if badge.sensor.shake() then
			handle_shake(now)
		end
	end
	if submit_record and not submission_committed and now > submit_record.deadline then
		submit_record = nil
		set_status("SHAKE WINDOW MISSED", "A failed submission still consumed its plate", 0xffcc66)
	end
	maybe_commit_submission(now)
	render_state(now)
	render_leds(now)
end

if badge == nil then
	player_test = {
		new_state = new_state,
		take_source = take_source,
		create_plate = create_plate,
		add_to_plate = add_to_plate,
		discard_state = discard_state,
		start_chop = start_chop,
		chop_step = chop_step,
		finish_chop = finish_chop,
		fail_chop = fail_chop,
		stove_phase = stove_phase,
		stove_action = stove_action,
		apply_peer_stove = apply_peer_stove,
		plate_summary = plate_summary,
		snapshot = snapshot,
		parse_snapshot = parse_snapshot,
		apply_transfer = apply_transfer,
		all_players_ready = all_players_ready,
		event_payload = event_payload,
		parse_event = parse_event,
		parse_control = parse_control,
		accept_control_sequence = accept_control_sequence,
		resolve_tag_action = resolve_tag_action,
		is_platable = is_platable,
	}
end
