"""Host checks that execute the gateway's Lua protocol helpers."""

import json
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT.parent / ".tools" / "python"))
from lupa.lua54 import LuaRuntime


class GatewayProtocolTests(unittest.TestCase):
    def run_lua(self, expression):
        script = "dofile(%s)\n%s\n" % (
            json.dumps(str(ROOT / "master" / "main.lua")),
            expression,
        )
        LuaRuntime().execute(script)

    def test_accepts_documented_event(self):
        self.run_lua(
            'assert(gateway_test.valid_player_packet("OC1|0042|N|ING:TOM"))\n'
            'assert(gateway_test.valid_player_packet("OC1|7|M|CHOP"))\n'
            'assert(gateway_test.valid_player_packet("OC1|42|X|CUSTOM"))'
        )

    def test_accepts_player_sender_order(self):
        self.run_lua(
            'assert(gateway_test.valid_player_packet("OC1|H|0001|P"))\n'
            'assert(gateway_test.valid_player_packet("OC1|E|0042|P:01"))\n'
            'assert(gateway_test.valid_player_packet("OC1|A|9999|AABBCCDDEEFF|HOST"))\n'
            'assert(gateway_test.valid_player_packet("OC1|U|9999|AABBCCDDEEFF|S04:999999"))\n'
            'assert(gateway_test.valid_player_packet("OC1|R|9999|AABBCCDDEEFF|NOTYET"))'
        )

    def test_rejects_malformed_or_unrelated_input(self):
        payloads = (
            "",
            "HELLO1:hi",
            "OC1|",
            "OC1|42|N|",
            "OC1|x|N|ING:TOM",
            "OC1|H|42|P",
            "OC1|0001|H|P|extra",
            "OC1|42|N|ING|TOM",
            "OC1|42|N|ING:TOM\n",
            "OC1|a|0001|P",
            "OC1|0001|a|P",
        )
        for payload in payloads:
            with self.subTest(payload=payload):
                self.run_lua(
                    "assert(not gateway_test.valid_player_packet(%s))"
                    % json.dumps(payload)
                )
        self.run_lua(
            "assert(not gateway_test.valid_player_packet("
            '"OC1|42|N|ING:" .. string.char(0) .. "TOM"))'
        )
        self.run_lua("assert(not gateway_test.valid_player_packet(nil))")

    def test_enforces_radio_size_boundaries(self):
        self.run_lua(
            'local payload = "OC1|1|N|" .. string.rep("X", 36)\n'
            "assert(#payload == 44)\n"
            "assert(gateway_test.valid_player_packet(payload))\n"
            'assert(not gateway_test.valid_player_packet(payload .. "X"))'
        )

    def test_serial_frame_preserves_payload_and_sender_metadata(self):
        self.run_lua(
            'local payload = "OC1|0042|N|ING:TOM"\n'
            'assert(gateway_test.serial_frame("AA:BB:CC:DD:EE:FF", -48, payload) == '
            '"HTN26|RX|AA:BB:CC:DD:EE:FF|-48|OC1|0042|N|ING:TOM")'
        )

    def test_burger_plate_and_host_scan_protocol(self):
        self.run_lua(
            'assert(gateway_test.valid_player_packet("OC1|E|0001|I:CHEESE"))\n'
            'assert(gateway_test.valid_player_packet("OC1|E|0002|I:LETTUCE"))\n'
            'assert(gateway_test.valid_player_packet("OC1|E|0003|I:MEAT"))\n'
            'assert(gateway_test.valid_player_packet("OC1|E|0004|I:BUNS"))\n'
            'assert(gateway_test.valid_player_packet("OC1|E|0005|S:CHOP1"))\n'
            'assert(gateway_test.valid_player_packet("OC1|E|0006|S:CHOP2"))\n'
            'assert(gateway_test.valid_player_packet("OC1|E|0007|S:STOVE1"))\n'
            'assert(gateway_test.valid_player_packet("OC1|E|0008|S:STOVE2"))\n'
            'assert(gateway_test.valid_player_packet("OC1|E|0009|P:01"))\n'
            'assert(gateway_test.valid_player_packet("OC1|E|0010|P:02"))\n'
            'assert(gateway_test.valid_player_packet("OC1|E|0011|P:03"))\n'
            'assert(gateway_test.valid_plate_tag("P:01"))\n'
            'assert(gateway_test.valid_plate_tag("P:02"))\n'
            'assert(gateway_test.valid_plate_tag("P:03"))\n'
            'assert(not gateway_test.valid_plate_tag("P:04"))\n'
            'assert(not gateway_test.valid_plate_tag("I:MEAT"))\n'
            'assert(gateway_test.plate_frame("P:02") == "HTN26|PLATE|P:02")\n'
            'assert(gateway_test.host_scan_frame() == "HTN26|HOST|SCAN|1PI|PHONE|BURGER")'
        )

    def test_queue_is_bounded_and_preserves_order(self):
        self.run_lua(
            "gateway_test.reset_queue()\n"
            'for number = 1, 8 do gateway_test.enqueue_packet("m", -1, tostring(number)) end\n'
            'assert(not gateway_test.enqueue_packet("m", -1, "overflow"))\n'
            "assert(gateway_test.queue_size() == 8)\n"
            "assert(gateway_test.queue_drops() == 1)\n"
            "local _, _, first = gateway_test.dequeue_packet()\n"
            'assert(first == "1")'
        )

    def test_queue_stays_bounded_under_burst(self):
        self.run_lua(
            "gateway_test.reset_queue()\n"
            'for number = 1, 1000 do gateway_test.enqueue_packet("m", -1, tostring(number)) end\n'
            "assert(gateway_test.queue_size() == 8)\n"
            "assert(gateway_test.queue_drops() == 992)"
        )

    def test_display_counters_saturate(self):
        self.run_lua(
            "assert(gateway_test.increment_counter(999998) == 999999)\n"
            "assert(gateway_test.increment_counter(999999) == 999999)\n"
            "assert(gateway_test.increment_counter(999997, 10) == 999999)"
        )


if __name__ == "__main__":
    unittest.main()
