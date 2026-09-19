"""Execute production Lua helpers; lifecycle/retries are checked by run_local.py."""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / ".tools" / "python"))
from lupa.lua54 import LuaRuntime


class ProtocolTests(unittest.TestCase):
    def setUp(self):
        self.lua = LuaRuntime(unpack_returned_tuples=True)
        self.lua.execute((ROOT / "badge/slave/main.lua").read_text(encoding="utf-8"))

    def test_tags_and_gateway_owned_delivery(self):
        self.lua.execute('''
          local tags = { ["ING:TOMATO"] = "ING:TOM", ["STATION:CHOP1"] = "STN:CHOP1",
            ["STATION:POT1"] = "STN:POT1", ["PLATE:1"] = "STN:PLATE" }
          for tag, value in pairs(tags) do
            assert(player_test.parse_tag(tag) == value)
            assert(player_test.format_event(42, "N", value) == "OC1|42|N|" .. value)
          end
          assert(player_test.parse_tag("STATION:DELIVERY") == nil)
          assert(player_test.parse_tag(nil) == nil)
        ''')

    def test_byte_limit_and_invalid_fields(self):
        self.lua.execute('''
          assert(#player_test.format_event(999999999, "N", string.rep("x", 28)) == 44)
          assert(player_test.format_event(999999999, "N", string.rep("x", 29)) == nil)
          assert(player_test.format_event(1, "N", "bad|field") == nil)
          assert(player_test.format_event(0, "N", "ING:TOM") == nil)
          assert(player_test.format_event(1.5, "N", "ING:TOM") == nil)
          assert(player_test.format_event(1, "N", string.char(255)) == nil)
        ''')

    def test_sequence_exhaustion_and_uid_debounce(self):
        self.lua.execute('''
          assert(player_test.next_sequence_after(0) == 1)
          assert(player_test.next_sequence_after(999999999) == nil)
          assert(player_test.same_tag("04A1", "04A1"))
          assert(not player_test.same_tag("04A1", "04A2"))
          assert(not player_test.same_tag(nil, nil))
        ''')


if __name__ == "__main__":
    unittest.main()
