"""Host-side checks for the pure OC1 player-badge protocol contract."""

from pathlib import Path
import unittest

MAX_RADIO_BYTES = 44
MAX_SEQUENCE = 999_999_999
MAX_ATTEMPTS = 3


SUPPORTED = {
    "ING:TOMATO",
    "STATION:CHOP1",
    "STATION:POT1",
    "PLATE:1",
}


def printable_ascii(value: str) -> bool:
    raw = value.encode("utf-8")
    return bool(raw) and all(32 <= byte <= 126 and byte != ord("|") for byte in raw)


def format_event(sequence: int, event_type: str, value: str) -> str:
    if not isinstance(sequence, int) or not 1 <= sequence <= MAX_SEQUENCE:
        raise ValueError("bad-sequence")
    if event_type != "N" or not printable_ascii(value):
        raise ValueError("bad-field")
    payload = f"OC1|{sequence}|{event_type}|{value}"
    if len(payload.encode("utf-8")) > MAX_RADIO_BYTES:
        raise ValueError("event-too-long")
    return payload


class Sequence:
    def __init__(self, current=0):
        self.current = current

    def reserve(self):
        if self.current >= MAX_SEQUENCE:
            raise ValueError("sequence-exhausted")
        self.current += 1
        return self.current


class Debouncer:
    """The app keys debounce on a card UID, not on event sequence."""

    def __init__(self):
        self.seen_uid = None

    def accept(self, uid):
        if not uid or uid == self.seen_uid:
            return False
        self.seen_uid = uid
        return True

    def clear(self):
        self.seen_uid = None


class RetryPlan:
    def __init__(self, payload, sequence):
        self.payload = payload
        self.sequence = sequence
        self.attempts = 0

    def next_attempt(self):
        if self.attempts >= MAX_ATTEMPTS:
            return None
        self.attempts += 1
        return self.payload


class ProtocolTests(unittest.TestCase):
    def test_formats_oc1_event_and_keeps_supported_values(self):
        for value in SUPPORTED:
            payload = format_event(42, "N", value)
            self.assertEqual(payload, f"OC1|42|N|{value}")
            self.assertLessEqual(len(payload.encode("utf-8")), MAX_RADIO_BYTES)

    def test_enforces_radio_byte_limit_and_field_safety(self):
        self.assertEqual(len(format_event(999_999_999, "N", "x" * 28).encode()), 44)
        with self.assertRaisesRegex(ValueError, "event-too-long"):
            format_event(999_999_999, "N", "x" * 29)
        with self.assertRaisesRegex(ValueError, "bad-field"):
            format_event(1, "N", "ING|TOMATO")
        with self.assertRaisesRegex(ValueError, "bad-field"):
            format_event(1, "N", "ING:TOMATO\n")
        with self.assertRaisesRegex(ValueError, "bad-field"):
            format_event(1, "N", "TOMATO\N{SNOWMAN}")

    def test_sequence_is_monotonic_and_exhaustion_does_not_wrap(self):
        sequence = Sequence()
        self.assertEqual([sequence.reserve(), sequence.reserve()], [1, 2])
        exhausted = Sequence(MAX_SEQUENCE)
        with self.assertRaisesRegex(ValueError, "sequence-exhausted"):
            exhausted.reserve()
        self.assertEqual(exhausted.current, MAX_SEQUENCE)

    def test_repeated_uid_is_debounced_until_rearmed(self):
        debouncer = Debouncer()
        self.assertTrue(debouncer.accept("04A1"))
        self.assertFalse(debouncer.accept("04A1"))
        self.assertTrue(debouncer.accept("04A2"))
        debouncer.clear()
        self.assertTrue(debouncer.accept("04A1"))

    def test_retry_plan_is_bounded_and_reuses_exact_payload_and_sequence(self):
        payload = format_event(7, "N", "ING:TOMATO")
        plan = RetryPlan(payload, 7)
        attempts = [plan.next_attempt(), plan.next_attempt(), plan.next_attempt()]
        self.assertEqual(attempts, [payload, payload, payload])
        self.assertEqual(plan.sequence, 7)
        self.assertIsNone(plan.next_attempt())
        self.assertEqual(plan.attempts, MAX_ATTEMPTS)

    def test_main_contains_only_documented_transport_and_limits(self):
        main = (Path(__file__).parents[1] / "main.lua").read_text()
        self.assertIn('"OC1|"', main)
        self.assertIn("local MAX_RADIO_BYTES = 44", main)
        self.assertIn("local MAX_ATTEMPTS = 3", main)
        self.assertIn("badge.nfc.enable()", main)
        self.assertIn("badge.radio.enable()", main)
        self.assertNotIn("badge.wifi", main)
        self.assertNotIn("badge.http", main)
        self.assertNotIn("badge.ble", main)


if __name__ == "__main__":
    unittest.main()
