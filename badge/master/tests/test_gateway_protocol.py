"""Focused host-side checks for the self-contained host badge app."""

import json
import subprocess
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT.parent / ".tools" / "python"))
try:
    from lupa.lua54 import LuaRuntime
except ModuleNotFoundError:  # The system Lua fallback keeps static checks portable.
    LuaRuntime = None


class LuaTestMixin:
    def run_lua(self, expression):
        script = "dofile(%s)\n%s\n" % (
            json.dumps(str(ROOT / "master" / "main.lua")),
            expression,
        )
        if LuaRuntime is not None:
            LuaRuntime().execute(script)
            return
        result = subprocess.run(
            ["lua", "-e", script], capture_output=True, text=True
        )
        self.assertEqual(result.returncode, 0, result.stderr)


class GatewayProtocolTests(LuaTestMixin, unittest.TestCase):
    def test_accepts_pi_protocol_payloads(self):
        self.run_lua(
            'assert(gateway_test.valid_player_packet("OC1|1|N|ING:TOM"))\n'
            'assert(gateway_test.valid_player_packet("OC1|0042|M|CHOP"))\n'
            'assert(gateway_test.valid_player_packet("OC1|4294967295|H|READY"))'
        )

    def test_rejects_malformed_payloads_and_wrong_framing(self):
        payloads = (
            "",
            "HELLO1:hi",
            "OC1|",
            "OC1|1|N|",
            "OC1|x|N|ING:TOM",
            "OC1|1|X|CUSTOM",
            "OC1|1|N|ING|TOM",
            "OC1|1|N|ING:TOM\n",
            "OC1|4294967296|N|TOO_BIG",
            "OC1|1|N|bad\rvalue",
        )
        for payload in payloads:
            with self.subTest(payload=payload):
                self.run_lua(
                    "assert(not gateway_test.valid_player_packet(%s))"
                    % json.dumps(payload)
                )
        self.run_lua(
            "assert(not gateway_test.valid_player_packet("
            '"OC1|1|N|ING:" .. string.char(0) .. "TOM"))'
        )

    def test_enforces_radio_payload_size_boundary(self):
        self.run_lua(
            'local payload = "OC1|1|N|" .. string.rep("X", 36)\n'
            "assert(#payload == 44)\n"
            "assert(gateway_test.valid_player_packet(payload))\n"
            'assert(not gateway_test.valid_player_packet(payload .. "X"))'
        )

    def test_validates_sender_identity_and_rssi(self):
        self.run_lua(
            'assert(gateway_test.valid_mac("AA:BB:CC:DD:EE:FF"))\n'
            'assert(gateway_test.valid_mac("aa:bb:cc:dd:ee:ff"))\n'
            'assert(not gateway_test.valid_mac("AABBCCDDEEFF"))\n'
            'assert(not gateway_test.valid_mac("AA:BB:CC:DD:EE:FG"))\n'
            "assert(gateway_test.valid_rssi(-127))\n"
            "assert(gateway_test.valid_rssi(20))\n"
            "assert(not gateway_test.valid_rssi(-128))\n"
            "assert(not gateway_test.valid_rssi(21))"
        )

    def test_serial_frame_preserves_sender_rssi_and_payload(self):
        self.run_lua(
            'local payload = "OC1|0042|N|ING:TOM"\n'
            'assert(gateway_test.serial_rx_frame("AA:BB:CC:DD:EE:FF", -48, payload) == '
            '"HTN26|RX|AA:BB:CC:DD:EE:FF|-48|OC1|0042|N|ING:TOM")'
        )

    def test_lifecycle_frames_are_stable_and_bounded(self):
        self.run_lua(
            'local start = gateway_test.serial_start_frame()\n'
            'local finish = gateway_test.serial_end_frame()\n'
            'assert(start == "HTN26|GAME|START_GAME|120|3")\n'
            'assert(finish == "HTN26|GAME|GAME_END|3")\n'
            'assert(gateway_test.lifecycle_radio_frame("START_GAME") == "OC1|000001|G|S")\n'
            'assert(gateway_test.lifecycle_radio_frame("GAME_END") == "OC1|000002|G|E")\n'
            'assert(#start <= 44 and #finish <= 44)\n'
            'assert(#gateway_test.lifecycle_radio_frame("START_GAME") <= 44)'
        )

    def test_fifo_is_bounded_and_preserves_order(self):
        self.run_lua(
            "gateway_test.reset_queue()\n"
            'for number = 1, 8 do gateway_test.enqueue_packet("AA:BB:CC:DD:EE:FF", -1, tostring(number)) end\n'
            'assert(not gateway_test.enqueue_packet("AA:BB:CC:DD:EE:FF", -1, "overflow"))\n'
            "assert(gateway_test.queue_size() == 8)\n"
            "assert(gateway_test.queue_drops() == 1)\n"
            "local _, _, first = gateway_test.dequeue_packet()\n"
            'assert(first == "1")\n'
            "gateway_test.reset_session()\n"
            "assert(gateway_test.queue_size() == 0)"
        )

    def test_session_reset_has_three_player_slots(self):
        self.run_lua(
            "gateway_test.reset_session()\n"
            "assert(gateway_test.player_count() == 3)"
        )

    def test_last_event_display_is_bounded_and_keeps_metadata(self):
        self.run_lua(
            'local text = gateway_test.format_last_event()\n'
            'assert(text == "Last: none")\n'
            'local sender = "AA:BB:CC:DD:EE:FF"\n'
            'local rssi = -48\n'
            'local payload = "OC1|0042|N|" .. string.rep("X", 36)\n'
            'text = gateway_test.format_last_event(sender, rssi, payload)\n'
            'assert(string.find(text, "AA:BB:CC:DD:EE:FF", 1, true) ~= nil)\n'
            'assert(string.find(text, "RSSI -48 dBm", 1, true) ~= nil)\n'
            'assert(string.find(text, "...", 1, true) ~= nil)\n'
            'local payload_line = string.match(text, "[^\\n]+$")\n'
            'assert(#payload_line == gateway_test.event_max_payload_chars())'
        )


class HostLifecycleTests(LuaTestMixin, unittest.TestCase):
    def test_start_and_timeout_emit_lifecycle_records(self):
        self.run_lua(
            "now = 0\n"
            "logs, broadcasts = {}, {}\n"
            "local function noop() end\n"
            "local function make_label(_, text)\n"
            "  local label = {text = text}\n"
            "  function label:style(_) end\n"
            "  function label:align(_, _, _) end\n"
            "  function label:set_text(value) self.text = value end\n"
            "  function label:set_color(_) end\n"
            "  return label\n"
            "end\n"
            "badge = {\n"
            "  radio = {\n"
            "    enable = function() return true end,\n"
            "    on_recv = function(_) end,\n"
            "    dropped = function() return 0 end,\n"
            "    send = function(value) broadcasts[#broadcasts + 1] = value; return true end,\n"
            "    disable = noop,\n"
            "  },\n"
            "  sys = {ms = function() return now end, log = function(value) logs[#logs + 1] = value end},\n"
            "  led = {clear = noop, show = noop, set = noop, set_all = noop},\n"
            "  ui = {label = make_label},\n"
            "  input = {BUTTON = {START = 8}, KIND = {PRESSED = 1}},\n"
            "}\n"
            "on_enter({})\n"
            "on_button(8, 1)\n"
            'assert(logs[2] == "HTN26|GAME|START_GAME|120|3")\n'
            'assert(logs[3] == "HTN26|HOST|CONTROL|OC1|000001|G|S")\n'
            'assert(broadcasts[1] == "OC1|000001|G|S")\n'
            "now = 120000\n"
            "on_tick()\n"
            'assert(logs[4] == "HTN26|GAME|GAME_END|3")\n'
            'assert(logs[5] == "HTN26|HOST|CONTROL|OC1|000002|G|E")\n'
            'assert(broadcasts[2] == "OC1|000002|G|E")'
        )


class HostAppStaticChecks(unittest.TestCase):
    def test_event_region_is_below_status_and_bounded(self):
        source = (ROOT / "master" / "main.lua").read_text()
        self.assertIn("local EVENT_TOP_Y = 154", source)
        self.assertIn('event_label:align("top_mid", 0, EVENT_TOP_Y)', source)
        self.assertIn("local EVENT_MAX_PAYLOAD_CHARS = 32", source)
        self.assertNotIn('event_label:align("center", 0, 18)', source)

    def test_app_is_self_contained_and_uses_documented_boundary(self):
        source = (ROOT / "master" / "main.lua").read_text()
        manifest = (ROOT / "master" / "manifest.cfg").read_text()
        self.assertNotIn("require(", source)
        self.assertIn("badge.radio.enable", source)
        self.assertIn("badge.radio.on_recv", source)
        self.assertIn("badge.sys.log", source)
        self.assertNotIn("transport", source)
        self.assertLessEqual(len(source.encode()), 64 * 1024)
        self.assertIn("slug=master", manifest)
        self.assertIn("api=2", manifest)
        self.assertIn("wake_lock=1", manifest)


if __name__ == "__main__":
    unittest.main()
