"""Host-side checks for the gateway's documented packet contract.

The badge runtime has no host test runner in this repository, so these tests
exercise the same pure filtering/framing and bounded-queue rules used by the
Lua gateway. They intentionally do not inspect source text.
"""

import unittest


MAX_RADIO_PAYLOAD = 44
MIN_PACKET_LENGTH = 9
MAX_COUNTER = 999999


def valid_player_packet(payload):
    """Return whether payload is a well-formed, bounded OC1 event."""
    if not isinstance(payload, str):
        return False
    if not MIN_PACKET_LENGTH <= len(payload) <= MAX_RADIO_PAYLOAD:
        return False
    if not payload.startswith("OC1|"):
        return False
    if any(char in payload for char in ("\x00", "\r", "\n")):
        return False
    fields = payload.split("|")
    if len(fields) != 4 or fields[0] != "OC1":
        return False
    sequence, kind, value = fields[1:]
    if not sequence or any(char < "0" or char > "9" for char in sequence):
        return False
    if kind not in "NMBH" or not value:
        return False
    return True


def serial_frame(mac, rssi, payload):
    """Build the exact logical line sent to badge.sys.log()."""
    return f"HTN26|RX|{mac}|{rssi}|{payload}"


def increment_counter(value, amount=1):
    """Model the app's saturating display counters."""
    return min(MAX_COUNTER, value + amount)


class BoundedPacketQueue:
    """Small FIFO model of the gateway queue."""

    def __init__(self, capacity):
        self._items = []
        self.capacity = capacity
        self.drops = 0

    def enqueue(self, item):
        if len(self._items) >= self.capacity:
            self.drops += 1
            return False
        self._items.append(item)
        return True

    def dequeue(self):
        if not self._items:
            return None
        return self._items.pop(0)

    def __len__(self):
        return len(self._items)


class GatewayProtocolTests(unittest.TestCase):
    def test_accepts_documented_event(self):
        self.assertTrue(valid_player_packet("OC1|0042|N|ING:TOM"))
        self.assertTrue(valid_player_packet("OC1|7|M|CHOP"))

    def test_rejects_malformed_or_unrelated_input(self):
        malformed = (
            None,
            "",
            "HELLO1:hi",
            "OC1|",
            "OC1|42|N|",
            "OC1|x|N|ING:TOM",
            "OC1|42|X|ING:TOM",
            "OC1|42|N|ING|TOM",
            "OC1|42|N|ING:TOM\n",
            "OC1|42|N|ING:\x00TOM",
        )
        for payload in malformed:
            with self.subTest(payload=payload):
                self.assertFalse(valid_player_packet(payload))

    def test_enforces_radio_size_boundaries(self):
        value_at_limit = "X" * (MAX_RADIO_PAYLOAD - len("OC1|1|N|"))
        self.assertEqual(len("OC1|1|N|" + value_at_limit), MAX_RADIO_PAYLOAD)
        self.assertTrue(valid_player_packet("OC1|1|N|" + value_at_limit))
        self.assertFalse(valid_player_packet("OC1|1|N|" + value_at_limit + "X"))

    def test_serial_frame_preserves_payload_and_sender_metadata(self):
        payload = "OC1|0042|N|ING:TOM"
        self.assertEqual(
            serial_frame("AA:BB:CC:DD:EE:FF", -48, payload),
            "HTN26|RX|AA:BB:CC:DD:EE:FF|-48|OC1|0042|N|ING:TOM",
        )
        self.assertEqual(
            serial_frame("AA:BB:CC:DD:EE:FF", -48, payload),
            serial_frame("AA:BB:CC:DD:EE:FF", -48, payload),
        )

    def test_queue_is_bounded_and_preserves_order(self):
        queue = BoundedPacketQueue(capacity=2)
        self.assertTrue(queue.enqueue("first"))
        self.assertTrue(queue.enqueue("second"))
        self.assertFalse(queue.enqueue("third"))
        self.assertEqual(len(queue), 2)
        self.assertEqual(queue.drops, 1)
        self.assertEqual(queue.dequeue(), "first")
        self.assertTrue(queue.enqueue("third"))
        self.assertEqual(queue.dequeue(), "second")
        self.assertEqual(queue.dequeue(), "third")
        self.assertIsNone(queue.dequeue())

    def test_queue_stays_bounded_under_burst(self):
        queue = BoundedPacketQueue(capacity=8)
        for number in range(1000):
            queue.enqueue(number)
        self.assertLessEqual(len(queue), 8)
        self.assertEqual(queue.drops, 992)

    def test_display_counters_saturate(self):
        self.assertEqual(increment_counter(MAX_COUNTER - 1), MAX_COUNTER)
        self.assertEqual(increment_counter(MAX_COUNTER), MAX_COUNTER)
        self.assertEqual(increment_counter(MAX_COUNTER - 2, 10), MAX_COUNTER)


if __name__ == "__main__":
    unittest.main()
