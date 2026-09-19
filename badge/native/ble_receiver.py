"""Windows BLE PING/PONG test peer. No serial connection or game state."""
import argparse
import asyncio
from pathlib import Path
import secrets
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / ".tools/ble"))
COMPANY = 0xFFFF  # Existing badge HAL's manufacturer ID; OC1 separates our packets.


def decode(data):
    if len(data) != 17 or data[:9] not in (b"OC1|PING|", b"OC1|PONG|"):
        return None
    if any(c not in b"0123456789abcdef" for c in data[9:]):
        return None
    return data[4:8].decode(), data[9:].decode()


def packet(kind, token):
    result = f"OC1|{kind}|{token}".encode("ascii")
    if decode(result) is None:
        raise ValueError("Invalid diagnostic packet")
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
                token = secrets.token_hex(4)
                await advertise(packet("PING", token))
                started = time.monotonic()
                while True:
                    remaining = args.timeout - (time.monotonic() - started)
                    try:
                        data, rssi = await asyncio.wait_for(queue.get(), max(0, remaining))
                    except asyncio.TimeoutError:
                        print(f"TIMEOUT token={token}", flush=True)
                        break
                    if decode(data) == ("PONG", token):
                        successes += 1
                        print(f"RX {data.decode()} rssi={rssi} latency_ms={(time.monotonic()-started)*1000:.0f}", flush=True)
                        break
                await stop_publisher()
                await asyncio.sleep(.3)
            print(f"RESULT matched={successes}/{args.count} queue_drops={drops}", flush=True)
            if successes != args.count:
                raise RuntimeError("Not every PING received a matching PONG")
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
                kind, token = decode(data)
                if data != last:
                    print(f"RX {data.decode()} rssi={rssi}", flush=True)
                    last = data
                if (kind == "PING" and not args.listen_only
                        and (token != last_reply or time.monotonic() >= advertised_until)):
                    await advertise(packet("PONG", token))
                    last_reply = token
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
    parser.add_argument("--count", type=int, default=0, help="Send this many PINGs; default responds to badge PINGs")
    parser.add_argument("--seconds", type=float, default=60, help="Responder lifetime")
    parser.add_argument("--timeout", type=float, default=5)
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--listen-only", action="store_true", help="Receive only when adapter publishing is unavailable")
    args = parser.parse_args()
    if args.self_test:
        assert decode(packet("PING", "0123abcd")) == ("PING", "0123abcd")
        assert decode(packet("PONG", "fedcba98")) == ("PONG", "fedcba98")
        for bad in (b"PING", b"OC1|PING|0123ABCD", b"OC1|PING|0123abcd\0", b"OC2|PING|0123abcd", bytes(225)):
            assert decode(bad) is None
        print("PASS: packet format, strict length, namespace, and token validation")
    else:
        if not args.peer or args.count < 0 or args.seconds <= 0 or args.timeout <= 0:
            parser.error("Provide --peer and positive durations, nonnegative count")
        if args.listen_only and args.count:
            parser.error("--listen-only cannot send --count PINGs")
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
