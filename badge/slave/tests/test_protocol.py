"""Focused host-side checks for the production player badge Lua helpers."""

import unittest
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / ".tools" / "python"))
from lupa.lua54 import LuaRuntime  # noqa: E402 - test bootstrap adds the repo helper path first.


class PlayerBadgeTests(unittest.TestCase):
    def setUp(self):
        self.lua = LuaRuntime(unpack_returned_tuples=True)
        self.lua.execute((ROOT / "badge/slave/main.lua").read_text(encoding="utf-8"))

    def execute(self, code):
        self.lua.execute(code)

    def test_exact_four_zone_choices_and_invalid_combinations(self):
        self.execute("""
          local a, e = player_test.resolve_tag_action("pantry", false, true, false, false)
          assert(a == "BUN" and e == nil)
          a, e = player_test.resolve_tag_action("pantry", true, false, false, false)
          assert(a == "LETTUCE" and e == nil)
          a, e = player_test.resolve_tag_action("fridge", false, true, false, false)
          assert(a == "RAW_CHEESE" and e == nil)
          a, e = player_test.resolve_tag_action("fridge", true, false, false, false)
          assert(a == "RAW_MEAT" and e == nil)
          a, e = player_test.resolve_tag_action("cutting board", false, false, false, false)
          assert(a == nil and e == "UNKNOWN_BUTTON_COMBO")
          a, e = player_test.resolve_tag_action("stove", false, false, false, false)
          assert(a == nil and e == "UNKNOWN_BUTTON_COMBO")
          a, e = player_test.resolve_tag_action("unknown", true, false, false, false)
          assert(a == nil and e == "UNKNOWN_TAG")
        """)

    def test_compact_sequence_tagged_payloads_and_controls(self):
        self.execute("""
          local p = player_test.event_payload(42, 2, "PU:B")
          assert(p == "OC1|000042|E|P2:PU:B" and #p <= 44)
          local seq, player, action = player_test.parse_event(p)
          assert(seq == 42 and player == 2 and action == "PU:B")
          assert(player_test.event_payload(0, 1, "READY") == nil)
          assert(player_test.event_payload(1, 4, "READY") == nil)
          assert(player_test.event_payload(1, 1, "BAD|FIELD") == nil)
          assert(player_test.parse_event("OC1|000001|E|P1:READY" .. string.char(10)) == nil)
          local c, code = player_test.parse_control("OC1|000007|G|S")
          assert(c == 7 and code == "S")
          c, code = player_test.parse_control("OC1|000008|G|END")
          assert(c == 8 and code == "E")
        """)

    def test_control_sequences_are_monotonic(self):
        self.execute("""
          assert(player_test.accept_control_sequence(7))
          assert(not player_test.accept_control_sequence(7))
          assert(not player_test.accept_control_sequence(6))
          assert(player_test.accept_control_sequence(8))
        """)

    def test_pantry_plate_assembly_and_duplicate_prevention(self):
        self.execute("""
          local s = player_test.new_state()
          local ok, why = player_test.create_plate(s)
          assert(ok and why == "PLATE_NEW" and player_test.plate_summary(s.plate) == "----")
          ok, why = player_test.take_source(s, "RAW_LETTUCE")
          assert(not ok and why == "NOT_PLATABLE")
          ok, why = player_test.take_source(s, "LETTUCE")
          assert(ok and why == "PLATE_ADD")
          ok, why = player_test.take_source(s, "LETTUCE")
          assert(not ok and why == "DUPLICATE")
          ok, why = player_test.take_source(s, "BUN")
          assert(ok and player_test.plate_summary(s.plate) == "B-L-")
          ok, why = player_test.take_source(s, "RAW_MEAT")
          assert(not ok and why == "NOT_PLATABLE")
        """)

    def test_chopping_requires_hold_and_finishes_in_six_steps(self):
        self.execute("""
          local s = player_test.new_state()
          assert(player_test.take_source(s, "RAW_MEAT"))
          local ok, why = player_test.start_chop(s, 1000)
          assert(ok and why == "CHOP_START" and s.hand == nil)
          assert(player_test.chop_step(s, 1499) == 0)
          assert(player_test.chop_step(s, 1500) == 1)
          assert(player_test.chop_step(s, 4000) == 6)
          ok, why = player_test.finish_chop(s, 4000)
          assert(ok and why == "CHOP_DONE" and s.hand == "CHOPPED_MEAT")
          assert(player_test.snapshot(s) == "HD")
          assert(player_test.parse_snapshot("HD").hand == "CHOPPED_MEAT")
          assert(player_test.parse_snapshot("HM").hand == "MEAT")

          local failed = player_test.new_state()
          assert(player_test.take_source(failed, "RAW_CHEESE"))
          assert(player_test.start_chop(failed, 0))
          ok, why = player_test.fail_chop(failed)
          assert(ok and why == "CHOP_FAIL" and failed.hand == "RAW_CHEESE")
        """)

    def test_cooking_done_warning_burnt_and_burnt_drop(self):
        self.execute("""
          local s = player_test.new_state()
          assert(player_test.take_source(s, "RAW_MEAT"))
          assert(player_test.start_chop(s, 0))
          assert(player_test.finish_chop(s, 3000))
          local ok, why = player_test.stove_action(s, 1, 0)
          assert(ok and why == "PUT" and s.hand == nil)
          assert(player_test.stove_phase(s.stoves[1], 14999) == "COOKING")
          assert(player_test.stove_phase(s.stoves[1], 15000) == "DONE")
          assert(player_test.stove_phase(s.stoves[1], 17000) == "WARNING")
          assert(player_test.stove_phase(s.stoves[1], 20000) == "BURNT")
          ok, why = player_test.stove_action(s, 1, 20000)
          assert(ok and why == "TAKE_BURNT" and s.hand == "BURNT")
          assert(player_test.discard_state(s))
          assert(s.hand == nil and s.plate == nil)
        """)

    def test_tap_transfer_merges_or_swaps_without_duplicates(self):
        self.execute("""
          local plate_badge = player_test.new_state()
          assert(player_test.create_plate(plate_badge))
          assert(player_test.take_source(plate_badge, "BUN"))
          local item_badge = player_test.new_state()
          assert(player_test.take_source(item_badge, "MEAT"))
          local plate_snapshot = player_test.snapshot(plate_badge)
          local item_snapshot = player_test.snapshot(item_badge)
          assert(player_test.apply_transfer(plate_badge, player_test.parse_snapshot(item_snapshot)))
          assert(player_test.plate_summary(plate_badge.plate) == "BM--")
          assert(player_test.apply_transfer(item_badge, player_test.parse_snapshot(plate_snapshot)))
          assert(item_badge.hand == nil)

          local left, right = player_test.new_state(), player_test.new_state()
          assert(player_test.take_source(left, "BUN"))
          assert(player_test.take_source(right, "MEAT"))
          local ls, rs = player_test.snapshot(left), player_test.snapshot(right)
          assert(player_test.apply_transfer(left, player_test.parse_snapshot(rs)))
          assert(player_test.apply_transfer(right, player_test.parse_snapshot(ls)))
          assert(left.hand == "MEAT" and right.hand == "BUN")
        """)

    def test_three_fixed_ready_window_and_state_discard(self):
        self.execute("""
          local ready = { [1] = 500, [2] = 500, [3] = 500 }
          assert(player_test.all_players_ready(ready, 499))
          assert(not player_test.all_players_ready(ready, 501))
          ready[3] = 0
          assert(not player_test.all_players_ready(ready, 100))
          local s = player_test.new_state()
          assert(player_test.create_plate(s))
          assert(player_test.take_source(s, "BUN"))
          assert(player_test.discard_state(s))
          assert(s.plate == nil and s.hand == nil)
          local p = player_test.event_payload(9, 3, "SUB:BMLC")
          assert(player_test.parse_event(p) == 9)
        """)


if __name__ == "__main__":
    unittest.main()
