"""Execute compiled RV32IMC callbacks with firmware calls stubbed, not hardware."""
import struct
import re
import sys
from pathlib import Path
from build import ROOT, HERE, HOOK, decode

sys.path.insert(0, str(ROOT / ".tools/reverse"))
from unicorn import Uc, UC_ARCH_RISCV, UC_MODE_RISCV32, UC_HOOK_CODE
from unicorn.riscv_const import UC_RISCV_REG_A0, UC_RISCV_REG_A1, UC_RISCV_REG_RA, UC_RISCV_REG_SP, UC_RISCV_REG_PC


def scenario(nvs_error=0, radio_error=0, nfc_error=0, allocation_failure=False, send_error=0):
    cpu = Uc(UC_ARCH_RISCV, UC_MODE_RISCV32)
    for base, size in [(0x3C000000, 0x300000), (0x3FC80000, 0x80000),
                       (0x40380000, 0x20000), (0x42000000, 0x140000), (0x50000000, 0x1000)]:
        cpu.mem_map(base, size)
    _, segments, _ = decode((HERE / "build/overcooked-factory.bin").read_bytes())
    for address, data in segments:
        cpu.mem_write(address, data)
    cpu.reg_write(UC_RISCV_REG_SP, 0x3FCDF000)
    calls, registrations, texts, stages, prints = [], [], [], [], []
    app, old_app = 0x3FCC0000, 0x3FC9AB00
    label_count = 0
    handler, packets = [], []
    hardware = {"tag": None, "uid": b"\x04\xa1", "motion": "rest"}

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
            assert (a0, a1) == (1, 300)
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
        elif address == 0x42101718:
            result = nvs_error
        elif address == 0x420109C6:
            result = radio_error
        elif address == 0x40389792:
            result = 0x1234abcd
        elif address == 0x42010FC2:
            cpu.mem_write(a0, bytes.fromhex('e83dc12986d0'))
        elif address == 0x42010C54:
            assert 17 <= a1 < 45
            packets.append(bytes(cpu.mem_read(a0, a1)))
            result = send_error
        elif address == 0x4200FF2E:
            result = nfc_error
        elif address == 0x42010062:
            if hardware["tag"] is not None:
                card = bytearray(20)
                card[:len(hardware["uid"])] = hardware["uid"]
                struct.pack_into('<I', card, 12, len(hardware["uid"]))
                cpu.mem_write(a0, bytes(card))
                result = 1
        elif address == 0x42010138:
            data = hardware["tag"].encode() if hardware["tag"] is not None else b""
            cpu.mem_write(a0, data[:a1-1] + b'\0')
        elif address == 0x4200AED4:
            value = {"rest": 0x447A0000, "tap": 0x44A00000, "shake": 0x44FA0000}[hardware["motion"]]
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
        assert packet.endswith(b'|N|' + expected.encode()), packet
        incoming(b'OC1|' + packet[4:12] + b'|A|OK'); invoke(0x5c)

    assert string(invoke(0x08)) == "Overcooked"
    assert string(invoke(0x10)) == "overcooked"
    assert invoke(0x24) == 0 and invoke(0x2C) == 1
    assert invoke(0x40) == 0 and invoke(0x3C) == 20
    invoke(0x54, 0x3FCC2000)
    assert stages == ["entry"] and 0x420109C6 not in calls
    invoke(0x5C)
    assert stages[:2] == ["entry", "before_radio"]
    if nvs_error:
        assert 0x420109C6 not in calls and "NVS ERROR / RADIO NOT STARTED" in texts
    else:
        assert calls.index(0x42101718) < calls.index(0x420109C6)
        assert stages[2] == "after_radio"
        assert ("RADIO ERROR / SEE SERIAL" if radio_error else
                ("RADIO READY / NFC ERROR" if nfc_error else "CHOOSE ROLE: A PLAYER / START HOST")) in texts
    if not nvs_error and not radio_error:
        invoke(0x60, 0)  # Select player role.
        invoke(0x60, 0x100)
        incoming(b'OC1|11111111|N|GAME:START'); invoke(0x5c)
        assert packets[-1] == b'OC1|11111111|A|OK'
        packets.clear()
        invoke(0x60, 4)  # LEFT, packed press event; upper bits are ignored.
        if not nfc_error:
            scan('pantry')
        else:
            incoming(b'OC1|87654321|N|READY'); invoke(0x5c)
        assert packets == ([b'OC1|45441741|N|PICK:LETTUCE'] if not nfc_error
                           else [b'OC1|87654321|A|OK'])
        if send_error:
            assert 'RADIO SEND ERROR' in texts
        else:
            for bad in (b'MEAT', b'OC1|45441741|A|NO', b'OC1|4544174x|A|OK',
                        b'OC1|45441741|N|PICK:BEEF'):
                incoming(bad); invoke(0x5c)
            if not nfc_error:
                assert 'ACTION ACKNOWLEDGED' not in texts
                acknowledge('PICK:LETTUCE')
                assert any('HELD: LETTUCE' in text for text in texts)

                invoke(0x60, 0)  # Hold A, then scan cutting board.
                scan('cutting board'); acknowledge('CUT:START')
                assert 'CUTTING - KEEP HOLDING A' in texts
                invoke(0x60, 0x100)  # Early release loses all progress.
                assert 'CUT RESET - A RELEASED' in texts
                assert any('HELD: LETTUCE' in text for text in texts)
                acknowledge('CUT:FAIL')

                invoke(0x60, 0); scan('cutting board'); acknowledge('CUT:START')
                for _ in range(150): invoke(0x5c)
                acknowledge('CUT:DONE')
                invoke(0x60, 0x100)
                assert any('HELD: SLICED LETTUCE' in text for text in texts)
                invoke(0x60, 3); scan('pantry'); acknowledge('PLATE')
                assert any('PLATE: YES B- M- L+ C-' in text for text in texts)

                invoke(0x60, 4); before = len(packets); scan('fridge')
                assert len(packets) == before and 'UNKNOWN BUTTON COMBO' in texts
                invoke(0x60, 5); scan('fridge'); acknowledge('PICK:CHEESE')
                assert any('PLATE: YES B- M- L+ C+' in text for text in texts)

                # A + shake submits a fixed plate summary; Pi validates consensus/order.
                cpu.mem_write(app + 229, b'\x0f\x01')
                for _ in range(50): invoke(0x5c)
                invoke(0x60, 0); hardware["motion"] = "shake"; invoke(0x5c); hardware["motion"] = "rest"
                acknowledge('SUBMIT:BMLC'); invoke(0x60, 0x100)
                assert 'PLATE SUBMITTED TO PI' in texts

                for _ in range(25): invoke(0x5c)
                invoke(0x60, 4); scan('fridge'); acknowledge('PICK:MEAT')
                invoke(0x60, 1)  # Hold B and shake to discard.
                hardware["motion"] = "shake"; invoke(0x5c); hardware["motion"] = "rest"
                acknowledge('DISCARD'); invoke(0x60, 0x101)
                assert 'ITEM DROPPED' in texts

                incoming(b'OC1|22222222|N|BUMP:P:B---'); invoke(0x5c)
                assert cpu.mem_read(app + 229, 2) == b'\x01\x01'
                cpu.mem_write(app + 229, b'\0\0')

            incoming(b'OC1|76543210|N|PICK:MEAT'); invoke(0x5c)
            assert cpu.mem_read(app + 228, 1) == b'\0'  # Peer inventory never overwrites ours.
            count = len(packets)
            log_count = prints.count('HTN26|RX|%02x:%02x:%02x:%02x:%02x:%02x|%d|%s\n')
            incoming(b'OC1|87654321|N|STOVE1:PUT');invoke(0x5c)
            assert packets[-1] == b'OC1|87654321|A|OK' and len(packets) == count+1
            assert any(line.startswith('HTN26|RX|') for line in prints)
            incoming(b'OC1|87654321|N|STOVE1:PUT');invoke(0x5c)
            assert len(packets) == count+1  # Current ACK advertisement covers duplicates.
            for _ in range(100):invoke(0x5c)
            incoming(b'OC1|87654321|N|STOVE1:PUT');invoke(0x5c)
            assert len(packets) == count+2  # A later retry receives another ACK, not another log.
            assert prints.count('HTN26|RX|%02x:%02x:%02x:%02x:%02x:%02x|%d|%s\n') == log_count + 1
            for _ in range(1000): invoke(0x5c)
            assert any('STOVES: L BURNT' in text for text in texts)
            if not nfc_error:
                invoke(0x60, 5); scan('fridge')
                pending = packets[-1]
                assert pending.endswith(b'|N|PICK:CHEESE')
                incoming(b'OC1|00000001|A|OK');invoke(0x5c)
                before = len(texts); sent = len(packets)
                for _ in range(451):invoke(0x5c)
                assert packets[sent:] == [pending, pending]
                assert 'ACTION TIMEOUT / SCAN AGAIN' in texts[before:]
        if not nfc_error and not send_error:
            cpu.mem_write(app + 235, b'\0\0')  # Return to role selection for host lifecycle check.
            invoke(0x60, 8); invoke(0x60, 8)
            assert packets[-1].endswith(b'|N|GAME:START')
            assert 'HTN26|GAME|START|120\n' in prints
            cpu.mem_write(app + 288, struct.pack('<I', 1)); invoke(0x5c)
            assert packets[-1].endswith(b'|N|GAME:END')
            assert 'HTN26|GAME|END\n' in prints
    for _ in range(250):
        invoke(0x5C)
    assert ("idle" in stages) == (not nvs_error and not radio_error)
    assert calls.count(0x420109C6) == (0 if nvs_error else 1)
    invoke(0x58)
    assert 0x42011252 in calls and stages[-1] == "exit"
    assert cpu.mem_read(app + 4, 24) == bytes(24)
    if handler:
        before = len(packets)
        incoming(b'OC1|00000001|N|READY');invoke(0x5c)
        assert len(packets) == before


if __name__ == "__main__":
    scenario()
    scenario(nvs_error=0x110D)
    scenario(nvs_error=0x1110)
    scenario(radio_error=-1)
    scenario(nfc_error=-1)
    scenario(allocation_failure=True)
    scenario(send_error=-1)
    print("PASS: native NFC controls, cut reset/progress, shake discard/submit, shared stove events, retries, cleanup")
