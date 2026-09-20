"""Execute compiled RV32IMC callbacks with firmware calls stubbed, not hardware."""
import struct
import re
import sys
from build import ROOT, HERE, HOOK, decode

sys.path.insert(0, str(ROOT / "badge/assets/icons"))
from generate_native_icons import encode_rgb565a8, load_rgba_png, native_icon_data, resized_crop, NATIVE_SIZE

ICON_DATA = {name: data for name, _, data in native_icon_data()}
ICON_NAMES_BY_PIXELS = {}
for icon_name, icon_pixels in ICON_DATA.items():
    ICON_NAMES_BY_PIXELS.setdefault(icon_pixels, set()).add(icon_name)

sys.path.insert(0, str(ROOT / ".tools/reverse"))
from unicorn import Uc, UC_ARCH_RISCV, UC_MODE_RISCV32, UC_HOOK_CODE
from unicorn.riscv_const import UC_RISCV_REG_A0, UC_RISCV_REG_A1, UC_RISCV_REG_RA, UC_RISCV_REG_SP, UC_RISCV_REG_PC


def scenario(nvs_error=0, radio_error=0, nfc_error=0, allocation_failure=False,
             send_error=0, role="player", timeout_recovery=False):
    cpu = Uc(UC_ARCH_RISCV, UC_MODE_RISCV32)
    for base, size in [(0x3C000000, 0x270000), (0x3FC80000, 0x80000),
                       (0x40380000, 0x20000), (0x42000000, 0x140000), (0x50000000, 0x1000)]:
        cpu.mem_map(base, size)
    _, segments, _ = decode((HERE / "build/overcooked-factory.bin").read_bytes())
    for address, data in segments:
        # Image padding extends further than the stock runtime's mapped constants.
        cpu.mem_write(address, data[:0x3C270000-address] if address == 0x3C130020 else data)
    cpu.reg_write(UC_RISCV_REG_SP, 0x3FCDF000)
    calls, registrations, texts, stages, prints = [], [], [], [], []
    app, old_app = 0x3FCC0000, 0x3FC9AB00
    app_guard = b'HTN26-APP-GUARD' * 4
    cpu.mem_write(app + 308, app_guard)
    label_count = 0
    handler, packets = [], []
    image_object = 0x3FCC2800
    display = {"hidden": True, "icons": set(), "updates": []}
    hardware = {"tag": None, "uid": b"\x04\xa1", "motion": "rest", "nfc_text_error": 0,
                "nfc_text_calls": 0}

    def string(address):
        result = bytearray()
        for _ in range(512):
            value = cpu.mem_read(address + len(result), 1)[0]
            if value == 0:
                return result.decode()
            result.append(value)
        raise AssertionError("Unterminated string")

    def callback(machine, address, size, _):
        nonlocal label_count
        if address == HOOK or address == HOOK + 4 or 0x4212C720 <= address < 0x42130000:
            return
        # Execute the stock std::function move/copy/destructor and AD parser,
        # not a mocked reconstruction of their private ABI.
        if (0x42011016 <= address < 0x42011252 or 0x42011330 <= address < 0x4201136c
                or 0x4205e506 <= address < 0x4205e544
                or 0x4200b032 <= address < 0x4200b046 or 0x4200b3e0 <= address < 0x4200b3fa):
            if address == 0x42011330:
                pointer = machine.reg_read(UC_RISCV_REG_A0)
                handler[:] = struct.unpack('<4I', cpu.mem_read(pointer, 16))
                assert handler[:3] == [app, 0, 0x4205e52a]
            return
        a0, a1 = machine.reg_read(UC_RISCV_REG_A0), machine.reg_read(UC_RISCV_REG_A1)
        calls.append(address)
        result = 0
        if address == 0x420385A0:
            result = old_app
        elif address == 0x4203AACE:
            registrations.append(a0)
        elif address == 0x40397474:
            assert (a0, a1) == (1, 312)
            result = 0 if allocation_failure else app
        elif address == 0x4211B726:
            text = string(a0)
            prints.append(text)
            if "internal8_free" in text:
                stages.append(string(a1))
        elif address in (0x420023A6, 0x420024AC):
            assert a0 in (0x804, 0x1000)
            result = 160000
        elif address == 0x420BD958:
            result = a0
        elif address == 0x420CE062:
            label_count += 1
            result = 0x3FCC1000 + 64 * label_count
        elif address == 0x420CE086:
            texts.append(string(a1))
        elif address == 0x420CCC76:
            result = image_object
        elif address == 0x420CD1AC:
            assert a0 == image_object
            magic, color_format, flags, width, height, stride, reserved = struct.unpack(
                '<BB5H', cpu.mem_read(a1, 12))
            data_size, data_pointer, descriptor_reserved = struct.unpack(
                '<III', cpu.mem_read(a1 + 12, 12))
            assert (magic, color_format, flags, width, height, stride, reserved) == (
                0x19, 0x14, 0, NATIVE_SIZE, NATIVE_SIZE, NATIVE_SIZE * 2, 0)
            assert data_size == NATIVE_SIZE * NATIVE_SIZE * 3 and descriptor_reserved == 0
            pixels = bytes(cpu.mem_read(data_pointer, data_size))
            assert pixels in ICON_NAMES_BY_PIXELS
            display["icons"] = ICON_NAMES_BY_PIXELS[pixels]
            display["updates"].append(("source", sorted(display["icons"])))
        elif address in (0x420A73C4, 0x420A6C5C):
            assert a0 == image_object and a1 == 1
            display["hidden"] = address == 0x420A73C4
            display["updates"].append(("hidden", display["hidden"]))
        elif address == 0x42101718:
            result = nvs_error
        elif address == 0x420109C6:
            result = radio_error
        elif address == 0x40389792:
            result = 0x1234abcd
        elif address == 0x42010FC2:
            cpu.mem_write(a0, bytes.fromhex('e83dc12986d0'))
        elif address == 0x42010C54:
            assert 14 <= a1 < 45
            packets.append(bytes(cpu.mem_read(a0, a1)))
            result = send_error
        elif address == 0x4200FF2E:
            result = nfc_error
        elif address == 0x42010016:
            if timeout_recovery is True:
                hardware["nfc_text_error"] = 0  # A stale selection needs an RF reset, not another read.
        elif address == 0x42010062:
            if hardware["tag"] is not None:
                card = bytearray(20)
                card[:len(hardware["uid"])] = hardware["uid"]
                struct.pack_into('<I', card, 12, len(hardware["uid"]))
                cpu.mem_write(a0, bytes(card))
                result = 1
        elif address == 0x42010138:
            hardware["nfc_text_calls"] += 1
            result = hardware["nfc_text_error"]
            if not result:
                data = hardware["tag"].encode() if hardware["tag"] is not None else b""
                cpu.mem_write(a0, data[:a1-1] + b'\0')
        elif address == 0x4200AED4:
            value = {"rest": 0x447A0000, "tap": 0x44A00000,
                     "drop_shake": 0x44BB8000, "shake": 0x44FA0000}[hardware["motion"]]
            cpu.mem_write(a0, struct.pack('<3I', 0, 0, value))
        elif address == 0x4211BC16:
            fmt = string(machine.reg_read(UC_RISCV_REG_A0 + 2))
            arguments = [machine.reg_read(UC_RISCV_REG_A0 + i) for i in range(3, 8)]
            arguments += list(struct.unpack('<12I', cpu.mem_read(machine.reg_read(UC_RISCV_REG_SP), 48)))
            def replace(match):
                value = arguments.pop(0)
                spec = match.group()
                if spec.endswith('s'):
                    value = string(value)
                elif spec.endswith('d') and value & 0x80000000:
                    value -= 0x100000000
                return spec % value
            rendered = re.sub(r'%(?:\.\d+|0\d+)?[csxud]', replace, fmt).encode()
            cpu.mem_write(a0, rendered[:a1-1] + b'\0')
            result = len(rendered)
        else:
            assert address in (0x420A908C, 0x420A90B2, 0x420AE15C,
                               0x420AE11A, 0x420ADDEA, 0x420ADE14, 0x42011252,
                               0x42010CC2, 0x42010D36, 0x4200F4CA, 0x4200F58A, 0x4200F54A,
                               0x4201093C, 0x420073B4, 0x42010DBE,
                               0x42010016, 0x420100FC), hex(address)
        machine.reg_write(UC_RISCV_REG_A0, result & 0xFFFFFFFF)
        machine.reg_write(UC_RISCV_REG_PC, machine.reg_read(UC_RISCV_REG_RA))

    cpu.hook_add(UC_HOOK_CODE, callback)
    cpu.emu_start(HOOK, HOOK + 8, count=100000)
    assert cpu.reg_read(UC_RISCV_REG_PC) == HOOK + 8
    assert registrations == ([old_app] if allocation_failure else [old_app, app])
    if allocation_failure:
        assert bytes(cpu.mem_read(app + 308, len(app_guard))) == app_guard
        return
    table, = struct.unpack("<I", cpu.mem_read(app, 4))

    def execute(entry, *arguments):
        for index, value in enumerate(arguments):
            cpu.reg_write(UC_RISCV_REG_A0 + index, value)
        cpu.reg_write(UC_RISCV_REG_RA, 0x42000000)
        cpu.emu_start(entry, 0x42000000, count=100000)
        assert cpu.reg_read(UC_RISCV_REG_PC) == 0x42000000
        return cpu.reg_read(UC_RISCV_REG_A0)

    def invoke(slot, second=0):
        entry, = struct.unpack("<I", cpu.mem_read(table + slot, 4))
        return execute(entry, app, second)

    def incoming(data):
        base = 0x3FCC3000
        event = bytearray(32)
        event[0] = 0x13  # NimBLE extended advertising report.
        event[8:14] = bytes.fromhex('665544332211')
        event[14] = 196  # -60 dBm.
        advertisement = bytes([len(data)+3, 0xff, 0xff, 0xff]) + data
        event[0x16] = len(advertisement)
        struct.pack_into('<I', event, 0x18, base+64)
        cpu.mem_write(base, bytes(event))
        cpu.mem_write(base+64, advertisement)
        execute(0x420110f4, base, 0)

    scan_number = 0
    def scan(text):
        nonlocal scan_number
        scan_number += 1
        hardware["uid"] = bytes((4, scan_number))
        hardware["tag"] = text
        for _ in range(10): invoke(0x5c)
        hardware["tag"] = None

    def acknowledge(expected):
        packet = packets[-1]
        assert packet.endswith(b':' + expected.encode()), packet
        incoming(b'OC2|' + packet[4:10] + b'|A|OK'); invoke(0x5c)

    def assert_icon(expected):
        actual = set() if display["hidden"] else display["icons"]
        assert (not expected and not actual) or expected in actual, (expected, actual, display["updates"][-6:])

    assert string(invoke(0x08)) == "Overcooked"
    assert string(invoke(0x10)) == "overcooked"
    assert invoke(0x24) == 0 and invoke(0x2C) == 1
    assert invoke(0x40) == 0 and invoke(0x3C) == 20
    invoke(0x54, 0x3FCC2000)
    assert_icon(None)
    assert stages == ["entry"] and 0x420109C6 not in calls
    invoke(0x5C)
    assert stages == ["entry"]  # Role selection precedes every radio allocation.
    if role == "host":
        invoke(0x60, 8)
        assert "HOST STARTING RADIO" in texts
    else:
        invoke(0x60, 0)
        assert any("CHOOSE PLAYER 1" in text for text in texts)
        invoke(0x60, 5)  # Player 2 proves explicit fixed-number selection.
        assert any("CHOOSE PLAYER 2" in text for text in texts)
        invoke(0x60, 0)
        assert "PLAYER STARTING RADIO" in texts
    invoke(0x5C)
    assert stages[:2] == ["entry", "before_radio"]
    if nvs_error:
        assert 0x420109C6 not in calls and "NVS ERROR / RADIO NOT STARTED" in texts
    else:
        assert calls.index(0x42101718) < calls.index(0x420109C6)
        assert stages[2] == "after_radio"
        expected = "RADIO ERROR / SEE SERIAL" if radio_error else (
            "HOST READY - PRESS START" if role == "host" else
            ("RADIO READY / NFC ERROR" if nfc_error else "PLAYER READY - WAIT FOR START"))
        assert expected in texts
        if role != "host" and not radio_error:
            assert packets and re.match(rb'^OC2\|\d{6}\|P\|P2$', packets[-1]), packets
            packets.clear()
    if timeout_recovery == "persistent":
        hardware["nfc_text_error"] = 62760
        hardware["tag"] = 'pantry'
        for _ in range(200): invoke(0x5c)
        assert hardware["nfc_text_calls"] == 3, "persistent timeout must stop after two recoveries"
        assert calls.count(0x42010016) == 2
        assert calls.count(0x4200FF2E) == 3
        assert calls.count(0x420109C6) == 1
        assert not packets and 'NFC READ 62760 - REMOVE AND RETAP' in texts
        invoke(0x58)
        assert bytes(cpu.mem_read(app + 308, len(app_guard))) == app_guard
        return
    if role == "host":
        assert 0x4200FF2E not in calls  # The stationary gateway does not allocate/enable NFC.
        if nvs_error or radio_error:
            assert "HTN26|GW|DOWN|0|0\n" in prints
        else:
            assert "HTN26|GW|UP|0|0\n" in prints
            incoming(b'OC2|876542|P|P2'); invoke(0x5c)
            presence = 'HTN26|RX|%02x:%02x:%02x:%02x:%02x:%02x|%d|%s\n'
            assert prints.count(presence) == 1
            invoke(0x60, 8)
            assert packets[-1] == b'OC2|000001|G|S|3'
            assert "HTN26|GAME|START_GAME|240|3\n" in prints
            game_ticks, = struct.unpack('<I', cpu.mem_read(app + 288, 4))
            assert game_ticks == 12000
            forwarded = 'HTN26|RX|%02x:%02x:%02x:%02x:%02x:%02x|%d|%s\n'
            incoming(b'OC2|876543|E|P2:ST:L:P'); invoke(0x5c)
            assert packets[-1] == b'OC2|876543|A|OK'
            assert prints.count(forwarded) == 1
            sent = len(packets)
            incoming(b'OC2|876543|E|P2:ST:L:P'); invoke(0x5c)
            assert len(packets) == sent and prints.count(forwarded) == 1
            for _ in range(100): invoke(0x5c)
            incoming(b'OC2|876543|E|P2:ST:L:P'); invoke(0x5c)
            assert len(packets) == sent + 1 and prints.count(forwarded) == 1
            cpu.mem_write(app + 288, struct.pack('<I', 1)); invoke(0x5c)
            assert packets[-1] == b'OC2|000002|G|E|3'
            assert "HTN26|GAME|GAME_END|3\n" in prints
    elif not nvs_error and not radio_error:
        incoming(b'OC2|000001|G|S'); invoke(0x5c)
        assert_icon(None)
        assert packets == []  # Only the gateway acknowledges; player peers never stop retries.
        invoke(0x60, 4)  # LEFT, packed press event; upper bits are ignored.
        if not nfc_error:
            hardware["nfc_text_error"] = 0x105; scan('pantry')
            assert not packets and 'NFC READ 261 - REMOVE AND RETAP' in texts
            hardware["nfc_text_error"] = 0
            if timeout_recovery:
                hardware["nfc_text_error"] = 62760
            scan('pantry')
            if timeout_recovery:
                assert not packets
                assert 'NFC RESELECTING - HOLD TAG STILL' in texts
                hardware["tag"] = 'pantry'  # Same physical UID throughout recovery.
                for _ in range(20): invoke(0x5c)
                assert calls.count(0x42010016) == 1
                assert calls.count(0x4200FF2E) == 2
                assert calls.count(0x420109C6) == 1, "NFC recovery must leave BLE running"
            calls_after_scan = hardware["nfc_text_calls"]
            hardware["tag"] = 'pantry'
            for _ in range(100): invoke(0x5c)
            assert hardware["nfc_text_calls"] == calls_after_scan, "held tag must not be reread"
            hardware["tag"] = None
        else:
            incoming(b'OC2|876543|E|P3:READY'); invoke(0x5c)
        assert packets == ([b'OC2|441741|E|P2:PU:Q'] if not nfc_error else []), packets
        if send_error:
            assert 'RADIO SEND ERROR' in texts
        else:
            for bad in (b'MEAT', b'OC1|441741|E|P2:PU:Q', b'OC2|441741|A|NO',
                        b'OC2|44174x|A|OK', b'OC2|441741|E|P2:PU:Z'):
                incoming(bad); invoke(0x5c)
            if not nfc_error:
                assert 'ACTION ACKNOWLEDGED' not in texts
                acknowledge('PU:Q')
                assert_icon('lettuce')
                assert any('HELD: LETTUCE' in text for text in texts)

                invoke(0x60, 0)  # Hold A, then scan cutting board.
                scan('cutting board'); acknowledge('CH:S')
                assert_icon('lettuce')  # Cutting keeps the in-process item visible.
                assert 'CUTTING - KEEP HOLDING A' in texts
                invoke(0x60, 0x100)  # Early release loses all progress.
                assert_icon('lettuce')
                assert 'CUT RESET - A RELEASED' in texts
                assert any('HELD: LETTUCE' in text for text in texts)
                acknowledge('CH:F')

                invoke(0x60, 0); scan('cutting board'); acknowledge('CH:S')
                for _ in range(150): invoke(0x5c)
                acknowledge('CH:D:L')
                invoke(0x60, 0x100)
                assert_icon('chopped_lettuce')
                assert any('HELD: SLICED LETTUCE' in text for text in texts)
                invoke(0x60, 3); scan('pantry'); acknowledge('PL:--L-')
                assert_icon('plate')
                assert any('PLATE: YES B- M- L+ C-' in text for text in texts)
                # UP is held through the bump; pressing UP alone does not
                # transfer and A remains reserved for submission.
                before = len(packets); invoke(0x60, 6); invoke(0x5c)
                assert len(packets) == before
                hardware["motion"] = "tap"; invoke(0x5c); hardware["motion"] = "rest"
                assert packets[-1].endswith(b':X:P--L-')
                acknowledge('X:P--L-'); invoke(0x60, 0x106)
                for _ in range(25): invoke(0x5c)

                invoke(0x60, 4); before = len(packets); scan('fridge')
                assert len(packets) == before and 'UNKNOWN BUTTON COMBO' in texts
                invoke(0x60, 5); before = len(packets); scan('fridge')
                assert len(packets) == before and 'UNKNOWN BUTTON COMBO' in texts

                # B + a deliberate shake snapshots and clears a plate immediately,
                # without waiting for the gateway ACK to update local state.
                invoke(0x60, 1)
                hardware["motion"] = "drop_shake"; invoke(0x5c)
                assert packets[-1].endswith(b':DROP:P--L-')
                assert cpu.mem_read(app + 228, 3) == b'\0\0\0'
                assert_icon(None)
                sent = len(packets); dropped_packet = packets[-1]
                for _ in range(40): invoke(0x5c)
                assert len(packets) == sent, "one held shake must emit only one DROP"
                hardware["motion"] = "rest"
                for _ in range(109): invoke(0x5c)
                assert packets[-1] == dropped_packet and len(packets) == sent + 1
                assert cpu.mem_read(app + 228, 3) == b'\0\0\0'
                acknowledge('DROP:P--L-'); invoke(0x60, 0x101)
                for _ in range(25): invoke(0x5c)

                # B + shake with empty inventory is not a READY action and does not
                # manufacture an empty DROP payload. Releasing B cannot replay it.
                before = len(packets); invoke(0x60, 1)
                hardware["motion"] = "shake"
                for _ in range(40): invoke(0x5c)
                assert len(packets) == before
                invoke(0x60, 0x101)
                for _ in range(10): invoke(0x5c)
                assert len(packets) == before
                hardware["motion"] = "rest"
                for _ in range(25): invoke(0x5c)

                # A + shake submits a fixed plate summary; the server validates consensus/order.
                cpu.mem_write(app + 229, b'\x0f\x01')
                for _ in range(50): invoke(0x5c)
                invoke(0x60, 0); hardware["motion"] = "shake"; invoke(0x5c); hardware["motion"] = "rest"
                assert cpu.mem_read(app + 229, 2) == b'\0\0'  # Submission consumes immediately.
                assert_icon(None)  # The screen clears before the acknowledgement arrives.
                acknowledge('SUB:BMLC'); invoke(0x60, 0x100)
                assert_icon(None)
                assert 'PLATE SUBMITTED' in texts

                for _ in range(25): invoke(0x5c)
                invoke(0x60, 5); scan('pantry'); acknowledge('PU:B')
                assert_icon('bun')

                # A released B must not remain latched: this is READY, not DROP,
                # and the held bun remains intact.
                invoke(0x60, 1); invoke(0x60, 0x101)
                hardware["motion"] = "shake"; invoke(0x5c); hardware["motion"] = "rest"
                assert packets[-1].endswith(b':READY')
                assert cpu.mem_read(app + 228, 1) == bytes([5])
                assert_icon('bun')
                for _ in range(25): invoke(0x5c)
                before = len(packets); invoke(0x60, 1)
                hardware["motion"] = "drop_shake"; invoke(0x5c)
                assert len(packets) == before
                assert cpu.mem_read(app + 228, 1) == bytes([5])
                assert_icon('bun')
                hardware["motion"] = "rest"; invoke(0x60, 0x101)
                acknowledge('READY')
                for _ in range(25): invoke(0x5c)

                # B-held shake uses the lower deliberate-drop threshold, preserves
                # the pre-clear hand snapshot, and clears locally before ACK.
                invoke(0x60, 1); hardware["motion"] = "drop_shake"; invoke(0x5c)
                assert packets[-1].endswith(b':DROP:HB')
                assert cpu.mem_read(app + 228, 1) == b'\0'
                assert_icon(None)
                sent = len(packets)
                for _ in range(40): invoke(0x5c)
                assert len(packets) == sent, "sustained B-held shake must respect cooldown"
                hardware["motion"] = "rest"
                acknowledge('DROP:HB'); invoke(0x60, 0x101)
                assert_icon(None)

                for _ in range(25): invoke(0x5c)
                invoke(0x60, 5); scan('fridge'); acknowledge('PU:K')
                assert_icon('cheese')
                invoke(0x60, 0); scan('cutting board'); acknowledge('CH:S')
                for _ in range(150): invoke(0x5c)
                acknowledge('CH:D:C'); invoke(0x60, 0x100)
                assert_icon('chopped_cheese')
                assert any('HELD: SLICED CHEESE' in text for text in texts)
                invoke(0x60, 1); hardware["motion"] = "shake"; invoke(0x5c); hardware["motion"] = "rest"
                acknowledge('DROP:HC'); invoke(0x60, 0x101)
                assert_icon(None)
                for _ in range(25): invoke(0x5c)

                invoke(0x60, 4); scan('fridge'); acknowledge('PU:R')
                assert_icon('raw_meat')
                invoke(0x60, 1)  # Hold B and shake to discard.
                hardware["motion"] = "shake"; invoke(0x5c); hardware["motion"] = "rest"
                acknowledge('DROP:HR'); invoke(0x60, 0x101)
                assert_icon(None)
                assert 'ITEM DROPPED' in texts

                for _ in range(25): invoke(0x5c)
                cpu.mem_write(app + 228, b'\x01')
                incoming(b'OC2|333331|E|P1:READY'); invoke(0x5c)
                incoming(b'OC2|333333|E|P3:READY'); invoke(0x5c)
                hardware["motion"] = "shake"; invoke(0x5c); hardware["motion"] = "rest"
                assert cpu.mem_read(app + 228, 1) == b'\0'
                assert_icon(None)
                assert 'TEAM READY - HELD STATE CLEARED' in texts
                acknowledge('READY')

                # Full meat path: raw -> chopped -> stove -> cooked -> transferred.
                for _ in range(25): invoke(0x5c)
                invoke(0x60, 4); scan('fridge'); acknowledge('PU:R')
                assert_icon('raw_meat')
                invoke(0x60, 0); scan('cutting board'); acknowledge('CH:S')
                assert_icon('raw_meat')
                for _ in range(150): invoke(0x5c)
                acknowledge('CH:D:D'); invoke(0x60, 0x100)
                assert_icon('chopped_meat')
                invoke(0x60, 5); scan('stove')
                assert cpu.mem_read(app + 266, 2) == b'\0\x01', cpu.mem_read(app + 266, 2)
                acknowledge('ST:R:P')
                assert_icon(None)
                for _ in range(750): invoke(0x5c)
                invoke(0x60, 5); scan('stove'); acknowledge('ST:R:T')
                assert_icon('cooked_meat')

                # Room-wide transfer advertisements do not mutate an uninvolved
                # third badge. A matching local tap arms the bilateral exchange.
                before = len(packets)
                incoming(b'OC2|222220|E|P1:X:P----'); invoke(0x5c)
                assert len(packets) == before
                assert_icon('cooked_meat')
                hardware["motion"] = "tap"; invoke(0x5c); hardware["motion"] = "rest"
                assert packets[-1].endswith(b':X:HM')
                incoming(b'OC2|222225|E|P1:X:P----'); invoke(0x5c)
                assert_icon(None)
                acknowledge('X:HM')
                for _ in range(25): invoke(0x5c)

                hardware["motion"] = "tap"; invoke(0x5c); hardware["motion"] = "rest"
                incoming(b'OC2|222223|E|P1:X:HD'); invoke(0x5c)
                assert_icon('chopped_meat')
                acknowledge('X:E----')
                for _ in range(25): invoke(0x5c)
                hardware["motion"] = "tap"; invoke(0x5c); hardware["motion"] = "rest"
                incoming(b'OC2|222224|E|P1:X:E----'); invoke(0x5c)
                assert_icon(None)
                acknowledge('X:HD')
                for _ in range(25): invoke(0x5c)

                # An invalid raw-item merge swaps inventories, removing our plate.
                invoke(0x60, 3); scan('pantry'); acknowledge('PL:NEW')
                assert_icon('plate')
                hardware["motion"] = "tap"; invoke(0x5c); hardware["motion"] = "rest"
                incoming(b'OC2|222221|E|P1:X:HR'); invoke(0x5c)
                assert_icon('raw_meat')
                acknowledge('X:P----')

                incoming(b'OC2|000002|G|E'); invoke(0x5c)
                assert_icon(None)
                incoming(b'OC2|000003|G|S'); invoke(0x5c)
                assert_icon(None)

                before = len(packets)
                for _ in range(25): invoke(0x5c)
                incoming(b'OC2|222222|E|P1:X:PB---'); invoke(0x5c)
                assert len(packets) == before  # Unarmed player ignores peer transfer and never ACKs it.
                assert cpu.mem_read(app + 229, 2) == b'\0\0'  # Empty hand cannot take a peer plate.
                assert_icon(None)

            incoming(b'OC2|765432|E|P1:PU:R'); invoke(0x5c)
            assert cpu.mem_read(app + 228, 1) == b'\0'  # Peer inventory never overwrites ours.
            count = len(packets)
            incoming(b'OC2|876543|E|P1:ST:L:P'); invoke(0x5c)
            incoming(b'OC2|876543|E|P1:ST:L:P'); invoke(0x5c)
            for _ in range(100): invoke(0x5c)
            incoming(b'OC2|876543|E|P1:ST:L:P'); invoke(0x5c)
            assert len(packets) == count
            assert not any(line.startswith('HTN26|RX|') for line in prints)
            for _ in range(1000): invoke(0x5c)
            assert any('STOVES: L BURNT' in text for text in texts)
            if not nfc_error:
                invoke(0x60, 4); scan('stove'); acknowledge('ST:L:X')
                assert_icon('burnt_meat')
                assert any('HELD: BURNT MEAT' in text for text in texts)
                invoke(0x60, 1); hardware["motion"] = "shake"; invoke(0x5c); hardware["motion"] = "rest"
                acknowledge('DROP:HX'); invoke(0x60, 0x101)
                assert_icon(None)
                for _ in range(25): invoke(0x5c)
                invoke(0x60, 5); scan('fridge')
                pending = packets[-1]
                assert pending.endswith(b':PU:K')
                incoming(b'OC2|000001|A|OK'); invoke(0x5c)
                before = len(texts); sent = len(packets)
                for _ in range(451): invoke(0x5c)
                assert packets[sent:] == [pending, pending]
                assert 'ACTION TIMEOUT / SCAN AGAIN' in texts[before:]
    for _ in range(250):
        invoke(0x5C)
    assert ("idle" in stages) == (not nvs_error and not radio_error)
    assert calls.count(0x420109C6) == (0 if nvs_error else 1)
    invoke(0x58)
    assert 0x42011252 in calls and stages[-1] == "exit"
    assert cpu.mem_read(app + 4, 24) == bytes(24)
    assert bytes(cpu.mem_read(app + 308, len(app_guard))) == app_guard
    if handler:
        before = len(packets)
        incoming(b'OC2|000001|E|P1:READY');invoke(0x5c)
        assert len(packets) == before


if __name__ == "__main__":
    burnt_source = load_rgba_png(ROOT / "badge/assets/icons/ing_meat_burnt.png")
    assert ICON_DATA["burnt_meat"] == encode_rgb565a8(resized_crop(
        burnt_source, (0, 0, 42, 42), NATIVE_SIZE, NATIVE_SIZE))
    scenario()
    scenario(timeout_recovery=True)
    scenario(timeout_recovery="persistent")
    scenario(role="host")
    scenario(nvs_error=0x110D)
    scenario(nvs_error=0x1110, role="host")
    scenario(radio_error=-1)
    scenario(radio_error=-1, role="host")
    scenario(nfc_error=-1)
    scenario(allocation_failure=True)
    scenario(send_error=-1)
    print("PASS: native roles, B-held DROP hand/plate/empty/cooldown/release, gateway ACK/serial, lifecycle, cleanup")
