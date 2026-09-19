"""Host-side checks for the pure OC1 player-badge protocol contract."""

import unittest

MAX_RADIO_BYTES = 44
MAX_SEQUENCE = 999_999_999
MAX_ATTEMPTS = 3


SUPPORTED = {
    "ING:TOM",
    "STN:CHOP1",
    "STN:POT1",
    "STN:PLATE",
    "STN:DELIVERY",
}


TAG_VALUES = {
    "ING:TOMATO": "ING:TOM",
    "STATION:CHOP1": "STN:CHOP1",
    "STATION:POT1": "STN:POT1",
    "PLATE:1": "STN:PLATE",
    "STATION:DELIVERY": "STN:DELIVERY",
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


def canonical_tag(tag: str) -> str:
    try:
        return TAG_VALUES[tag]
    except KeyError as error:
        raise ValueError("unsupported") from error


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
        self.missing_polls = 0

    def accept(self, uid):
        if not uid or uid == self.seen_uid:
            return False
        self.seen_uid = uid
        return True

    def clear(self):
        self.seen_uid = None
        self.missing_polls = 0

    def observe_removal(self):
        self.missing_polls += 1
        if self.missing_polls >= 2:
            self.clear()


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
    def test_canonicalizes_supported_tag_values_for_oc1(self):
        for tag, expected in TAG_VALUES.items():
            value = canonical_tag(tag)
            payload = format_event(42, "N", value)
            self.assertIn(value, SUPPORTED)
            self.assertEqual(value, expected)
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
        debouncer.observe_removal()
        self.assertFalse(debouncer.accept("04A1"))
        debouncer.observe_removal()
        self.assertTrue(debouncer.accept("04A1"))

    def test_retry_plan_is_bounded_and_reuses_exact_payload_and_sequence(self):
        payload = format_event(7, "N", "ING:TOMATO")
        plan = RetryPlan(payload, 7)
        attempts = [plan.next_attempt(), plan.next_attempt(), plan.next_attempt()]
        self.assertEqual(attempts, [payload, payload, payload])
        self.assertEqual(plan.sequence, 7)
        self.assertIsNone(plan.next_attempt())
        self.assertEqual(plan.attempts, MAX_ATTEMPTS)

if __name__ == "__main__":
    unittest.main()
