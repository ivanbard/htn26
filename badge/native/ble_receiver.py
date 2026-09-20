"""Windows BLE gameplay-event/ACK test peer. No serial connection or game state."""
import argparse
import asyncio
from pathlib import Path
import secrets
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / ".tools/ble"))
COMPANY = 0xFFFF  # Existing badge HAL's manufacturer ID; OC1 separates our packets.
ACTIONS = {b"READY", b"CH:S", b"CH:F", b"PL:NEW",
           b"PU:B", b"PU:R", b"PU:Q", b"PU:K",
           b"ST:L:P", b"ST:L:T", b"ST:L:X",
           b"ST:R:P", b"ST:R:T", b"ST:R:X"}


def valid_plate(value):
    return len(value) == 4 and all(byte in (45, b"BMLC"[index])
                                    for index, byte in enumerate(value))


def valid_snapshot(value):
    return ((len(value) == 5 and value[:1] == b"P" and valid_plate(value[1:])) or
            value == b"E----" or
            (len(value) == 2 and value[:1] == b"H" and value[1:] in
             (b"B", b"R", b"M", b"X", b"Q", b"L", b"K", b"C")))


def valid_action(action):
    plate = ((len(action) == 7 and action[:3] == b"PL:" and valid_plate(action[3:])) or
             (len(action) == 8 and action[:4] == b"SUB:" and valid_plate(action[4:])))
    chop = len(action) == 6 and action[:5] == b"CH:D:" and action[5:] in (b"M", b"L", b"C")
    stove_check = action[:7] in (b"ST:L:C:", b"ST:R:C:") and action[7:] in \
        (b"EMPTY", b"COOKING", b"DONE", b"WARNING", b"BURNT")
    snapshot = ((action.startswith(b"DROP:") and valid_snapshot(action[5:])) or
                (action.startswith(b"X:") and valid_snapshot(action[2:])))
    return action in ACTIONS or plate or chop or stove_check or snapshot


def decode(data):
    if (17 <= len(data) < 45 and data[:4] == b"OC1|" and data[10:14] == b"|E|P" and
            data[14:15] in (b"1", b"2", b"3") and data[15:16] == b":" and valid_action(data[16:])):
        kind = "EVENT"
    elif len(data) == 15 and data[:4] == b"OC1|" and data[10:] == b"|A|OK":
        kind = "ACK"
    elif len(data) == 14 and data[:4] == b"OC1|" and data[10:13] == b"|G|" and data[13:] in (b"S", b"E"):
        kind = "CONTROL"
    else:
        return None
    if any(c not in b"0123456789" for c in data[4:10]):
        return None
    return kind, data[4:10].decode()


def packet(kind, sequence):
    suffix = "|E|P1:PU:R" if kind == "EVENT" else "|A|OK" if kind == "ACK" else ""
    result = f"OC1|{sequence}{suffix}".encode("ascii")
    if decode(result) is None:
        raise ValueError("Invalid controller packet")
    return result


async def run(args):
    from winrt.windows.devices.bluetooth import BluetoothAdapter
    from winrt.windows.devices.bluetooth.advertisement import (
        BluetoothLEAdvertisement, BluetoothLEManufacturerData,
        BluetoothLEAdvertisementPublisher, BluetoothLEAdvertisementPublisherStatus,
        BluetoothLEAdvertisementWatcher, BluetoothLEAdvertisementWatcherStatus)
    from winrt.windows.storage.streams import DataWriter

    adapter = await BluetoothAdapter.get_default_async()
    if adapter is None or not adapter.is_extended_advertising_supported:
        raise RuntimeError("Adapter does not report extended advertising support")
    print(f"ADAPTER extended=True peripheral={adapter.is_peripheral_role_supported}", flush=True)
    peer = int(args.peer.replace(":", ""), 16)
    loop = asyncio.get_running_loop()
    queue = asyncio.Queue(maxsize=32)
    drops = 0
    watcher = BluetoothLEAdvertisementWatcher()
    watcher.allow_extended_advertisements = True
    publisher = None
    publisher_subscription = None
    publisher_error = None

    def enqueue(item):
        nonlocal drops
        if queue.full():
            drops += 1
        else:
            queue.put_nowait(item)

    def received(_, event):
        if event.bluetooth_address != peer:
            return
        for manufacturer in event.advertisement.manufacturer_data:
            if manufacturer.company_id != COMPANY:
                continue
            data = bytes(memoryview(manufacturer.data))
            if decode(data):
                loop.call_soon_threadsafe(enqueue, (data, event.raw_signal_strength_in_dbm))

    async def stop_publisher():
        nonlocal publisher, publisher_subscription
        if publisher is None:
            return
        publisher.stop()
        end = time.monotonic() + 2
        while publisher.status not in (BluetoothLEAdvertisementPublisherStatus.STOPPED,
                                       BluetoothLEAdvertisementPublisherStatus.ABORTED):
            if time.monotonic() >= end:
                raise RuntimeError("Publisher did not stop")
            await asyncio.sleep(.02)
        publisher.remove_status_changed(publisher_subscription)
        publisher = None

    async def advertise(data):
        nonlocal publisher, publisher_subscription, publisher_error
        await stop_publisher()
        writer = DataWriter()
        writer.write_bytes(data)
        advertisement = BluetoothLEAdvertisement()
        advertisement.manufacturer_data.append(
            BluetoothLEManufacturerData(COMPANY, writer.detach_buffer()))
        publisher = BluetoothLEAdvertisementPublisher(advertisement)
        publisher.use_extended_advertisement = True
        publisher_error = None
        def status_changed(_, event):
            nonlocal publisher_error
            publisher_error = event.error
        publisher_subscription = publisher.add_status_changed(status_changed)
        publisher.start()
        end = time.monotonic() + 3
        while publisher.status != BluetoothLEAdvertisementPublisherStatus.STARTED:
            if publisher.status == BluetoothLEAdvertisementPublisherStatus.ABORTED or time.monotonic() >= end:
                raise RuntimeError(f"Publisher failed, status={publisher.status}, error={publisher_error!r}")
            await asyncio.sleep(.02)
        print(f"TX {data.decode()}", flush=True)

    subscription = watcher.add_received(received)
    try:
        watcher.start()
        await asyncio.sleep(.3)
        if watcher.status != BluetoothLEAdvertisementWatcherStatus.STARTED:
            raise RuntimeError(f"Watcher failed, status={watcher.status}; check Windows Bluetooth switch")
        print(f"READY peer={args.peer}", flush=True)
        if args.count:
            successes = 0
            for index in range(args.count):
                sequence = f"{secrets.randbelow(900000) + 100000:06d}"
                await advertise(packet("EVENT", sequence))
                started = time.monotonic()
                while True:
                    remaining = args.timeout - (time.monotonic() - started)
                    try:
                        data, rssi = await asyncio.wait_for(queue.get(), max(0, remaining))
                    except asyncio.TimeoutError:
                        print(f"TIMEOUT sequence={sequence}", flush=True)
                        break
                    if decode(data) == ("ACK", sequence):
                        successes += 1
                        print(f"RX {data.decode()} rssi={rssi} latency_ms={(time.monotonic()-started)*1000:.0f}", flush=True)
                        break
                await stop_publisher()
                await asyncio.sleep(.3)
            print(f"RESULT matched={successes}/{args.count} queue_drops={drops}", flush=True)
            if successes != args.count:
                raise RuntimeError("Not every event received a matching ACK")
        else:
            end = time.monotonic() + args.seconds
            last = None
            last_reply = None
            advertised_until = 0.0
            while time.monotonic() < end:
                try:
                    data, rssi = await asyncio.wait_for(queue.get(), .1)
                except asyncio.TimeoutError:
                    if publisher and time.monotonic() >= advertised_until:
                        await stop_publisher()
                    continue
                kind, sequence = decode(data)
                if data != last:
                    print(f"RX {data.decode()} rssi={rssi}", flush=True)
                    last = data
                if (kind == "EVENT" and not args.listen_only
                        and (sequence != last_reply or time.monotonic() >= advertised_until)):
                    await advertise(packet("ACK", sequence))
                    last_reply = sequence
                    advertised_until = time.monotonic() + 2
            mode = 'listener' if args.listen_only else 'responder'
            print(f"RESULT {mode} finished queue_drops={drops}", flush=True)
    finally:
        watcher.stop()
        watcher.remove_received(subscription)
        await stop_publisher()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--peer", help="Badge address from OC_NATIVE advertising_mac log")
    parser.add_argument("--count", type=int, default=0, help="Send this many events; default acknowledges badge events")
    parser.add_argument("--seconds", type=float, default=60, help="Responder lifetime")
    parser.add_argument("--timeout", type=float, default=5)
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--listen-only", action="store_true", help="Receive only when adapter publishing is unavailable")
    args = parser.parse_args()
    if args.self_test:
        assert decode(packet("EVENT", "012345")) == ("EVENT", "012345")
        assert decode(packet("ACK", "876543")) == ("ACK", "876543")
        assert decode(b"OC1|000001|G|S") == ("CONTROL", "000001")
        for action in ACTIONS:
            assert decode(b"OC1|012345|E|P2:" + action) == ("EVENT", "012345")
        assert decode(b"OC1|012345|E|P2:SUB:BMLC") == ("EVENT", "012345")
        assert decode(b"OC1|012345|E|P2:X:PB-L-") == ("EVENT", "012345")
        assert decode(b"OC1|012345|E|P2:X:HR") == ("EVENT", "012345")
        for bad in (b"MEAT", b"OC1|012345|E|P2:PU:Z", b"OC1|01234x|A|OK",
                    b"OC2|012345|A|OK", bytes(225)):
            assert decode(bad) is None
        print("PASS: packet format, strict length, namespace, and sequence validation")
    else:
        if not args.peer or args.count < 0 or args.seconds <= 0 or args.timeout <= 0:
            parser.error("Provide --peer and positive durations, nonnegative count")
        if args.listen_only and args.count:
            parser.error("--listen-only cannot send --count events")
        try:
            if len(args.peer.replace(":", "")) != 12:
                raise ValueError()
            int(args.peer.replace(":", ""), 16)
        except ValueError:
            parser.error("Invalid Bluetooth MAC")
        try:
            asyncio.run(run(args))
        except KeyboardInterrupt:
            pass
