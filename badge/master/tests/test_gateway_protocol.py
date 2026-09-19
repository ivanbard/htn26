"""Host checks that execute the gateway's Lua protocol helpers."""

import json
import shutil
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
LUA = next(
    (candidate for candidate in ("lua", "lua5.4", "lua5.3", "luajit")
     if shutil.which(candidate)),
    None,
)


@unittest.skipUnless(LUA, "Lua runtime is not installed")
class GatewayProtocolTests(unittest.TestCase):
    def run_lua(self, expression):
        script = "dofile(%s)\n%s\n" % (
            json.dumps(str(ROOT / "master" / "main.lua")), expression
        )
        result = subprocess.run(
            [LUA, "-"], input=script, text=True, capture_output=True,
            cwd=ROOT,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_accepts_documented_event(self):
        self.run_lua(
            'assert(gateway_test.valid_player_packet("OC1|0042|N|ING:TOM"))\n'
            'assert(gateway_test.valid_player_packet("OC1|7|M|CHOP"))'
        )

    def test_accepts_player_sender_order(self):
        self.run_lua(
            'assert(gateway_test.valid_player_packet("OC1|H|0001|P"))\n'
            'assert(gateway_test.valid_player_packet("OC1|E|0042|P:01"))'
        )

    def test_rejects_malformed_or_unrelated_input(self):
        payloads = (
            "", "HELLO1:hi", "OC1|", "OC1|42|N|", "OC1|x|N|ING:TOM",
            "OC1|42|X|ING:TOM", "OC1|H|42|P", "OC1|0001|H|P|extra",
            "OC1|42|N|ING|TOM", "OC1|42|N|ING:TOM\n",
            "OC1|42|N|ING:\x00TOM",
        )
        for payload in payloads:
            with self.subTest(payload=payload):
                self.run_lua(
                    "assert(not gateway_test.valid_player_packet(%s))"
                    % json.dumps(payload)
                )
        self.run_lua("assert(not gateway_test.valid_player_packet(nil))")

    def test_enforces_radio_size_boundaries(self):
        self.run_lua(
            'local payload = "OC1|1|N|" .. string.rep("X", 36)\n'
            'assert(#payload == 44)\n'
            'assert(gateway_test.valid_player_packet(payload))\n'
            'assert(not gateway_test.valid_player_packet(payload .. "X"))'
        )

    def test_serial_frame_preserves_payload_and_sender_metadata(self):
        self.run_lua(
            'local payload = "OC1|0042|N|ING:TOM"\n'
            'assert(gateway_test.serial_frame("AA:BB:CC:DD:EE:FF", -48, payload) == '
            '"HTN26|RX|AA:BB:CC:DD:EE:FF|-48|OC1|0042|N|ING:TOM")'
        )

    def test_queue_is_bounded_and_preserves_order(self):
        self.run_lua(
            'gateway_test.reset_queue()\n'
            'for number = 1, 8 do gateway_test.enqueue_packet("m", -1, tostring(number)) end\n'
            'assert(not gateway_test.enqueue_packet("m", -1, "overflow"))\n'
            'assert(gateway_test.queue_size() == 8)\n'
            'assert(gateway_test.queue_drops() == 1)\n'
            'local _, _, first = gateway_test.dequeue_packet()\n'
            'assert(first == "1")'
        )

    def test_queue_stays_bounded_under_burst(self):
        self.run_lua(
            'gateway_test.reset_queue()\n'
            'for number = 1, 1000 do gateway_test.enqueue_packet("m", -1, tostring(number)) end\n'
            'assert(gateway_test.queue_size() == 8)\n'
            'assert(gateway_test.queue_drops() == 992)'
        )

    def test_display_counters_saturate(self):
        self.run_lua(
            'assert(gateway_test.increment_counter(999998) == 999999)\n'
            'assert(gateway_test.increment_counter(999999) == 999999)\n'
            'assert(gateway_test.increment_counter(999997, 10) == 999999)'
        )


if __name__ == "__main__":
    unittest.main()
