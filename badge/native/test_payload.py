"""Execute compiled RV32IMC callbacks with firmware calls stubbed, not hardware."""
import struct
import re
import sys
from pathlib import Path
from build import ROOT, HERE, HOOK, decode

sys.path.insert(0, str(ROOT / ".tools/reverse"))
from unicorn import Uc, UC_ARCH_RISCV, UC_MODE_RISCV32, UC_HOOK_CODE
from unicorn.riscv_const import UC_RISCV_REG_A0, UC_RISCV_REG_A1, UC_RISCV_REG_RA, UC_RISCV_REG_SP, UC_RISCV_REG_PC


def scenario(nvs_error=0, radio_error=0, allocation_failure=False, send_error=0):
    cpu = Uc(UC_ARCH_RISCV, UC_MODE_RISCV32)
    for base, size in [(0x3C000000, 0x300000), (0x3FC80000, 0x80000),
                       (0x40380000, 0x20000), (0x42000000, 0x140000), (0x50000000, 0x1000)]:
        cpu.mem_map(base, size)
    _, segments, _ = decode((HERE / "build/overcooked-factory.bin").read_bytes())
    for address, data in segments:
        cpu.mem_write(address, data)
    cpu.reg_write(UC_RISCV_REG_SP, 0x3FCDF000)
    calls, registrations, texts, stages = [], [], [], []
    app, old_app = 0x3FCC0000, 0x3FC9AB00
    label_count = 0
    handler, packets = [], []

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
            assert (a0, a1) == (1, 128)
            result = 0 if allocation_failure else app
        elif address == 0x4211B726:
            text = string(a0)
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
            assert a1 == 17
            packets.append(bytes(cpu.mem_read(a0, a1)))
            result = send_error
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
            rendered = re.sub(r'%(?:\.\d+|0\d+)?[sxud]', replace, fmt).encode()
            cpu.mem_write(a0, rendered[:a1-1] + b'\0')
            result = len(rendered)
        else:
            assert address in (0x420A908C, 0x420A90B2, 0x420AE15C,
                               0x420AE11A, 0x420ADDEA, 0x420ADE14, 0x42011252,
                               0x42010CC2, 0x42010D36, 0x4200F4CA, 0x4200F58A, 0x4200F54A,
                               0x4201093C, 0x420073B4, 0x42010DBE), hex(address)
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

    assert string(invoke(0x08)) == "Overcooked"
    assert string(invoke(0x10)) == "overcooked"
    assert invoke(0x24) == 0 and invoke(0x2C) == 1
    assert invoke(0x40) == 0 and invoke(0x3C) == 20
    invoke(0x54, 0x3FCC2000)
    assert stages == ["entry"] and 0x420109C6 not in calls
    invoke(0x5C)
    assert stages[:2] == ["entry", "before_radio"]
    if nvs_error:
        assert 0x420109C6 not in calls and "NVS error\nRadio not started" in texts
    else:
        assert calls.index(0x42101718) < calls.index(0x420109C6)
        assert stages[2] == "after_radio"
        assert ("Radio error\nSee serial log" if radio_error else "Radio ready") in texts
    if not nvs_error and not radio_error:
        invoke(0x60, 0x100)  # A release does not send.
        assert not packets
        invoke(0x60, 0xa5a50000)  # Packed two-byte ABI leaves upper bits unspecified.
        assert packets == [b'OC1|PING|1234abcd']
        if send_error:
            assert 'Send error' in texts
        else:
            for bad in (b'PING', b'OC1|PONG|1234abcg', b'OC1|PONG|1234abcd\0'):
                incoming(bad); invoke(0x5c)
            assert 'PONG received' not in texts
            incoming(b'OC1|PONG|1234abcd');invoke(0x5c)
            assert 'PONG received' in texts
            count = len(packets)
            incoming(b'OC1|PING|87654321');invoke(0x5c)
            assert packets[-1] == b'OC1|PONG|87654321' and len(packets) == count+1
            incoming(b'OC1|PING|87654321');invoke(0x5c)
            assert len(packets) == count+1  # Duplicate advertisement.
            invoke(0x60, 0)
            incoming(b'OC1|PONG|deadbeef');invoke(0x5c)
            before = len(texts)
            for _ in range(251):invoke(0x5c)
            assert 'PONG timeout / A retries' in texts[before:]
    for _ in range(250):
        invoke(0x5C)
    assert "idle" in stages
    assert calls.count(0x420109C6) == (0 if nvs_error else 1)
    invoke(0x58)
    assert 0x42011252 in calls and stages[-1] == "exit"
    assert cpu.mem_read(app + 4, 24) == bytes(24)
    if handler:
        before = len(packets)
        incoming(b'OC1|PING|00000001');invoke(0x5c)
        assert len(packets) == before


if __name__ == "__main__":
    scenario()
    scenario(nvs_error=0x110D)
    scenario(nvs_error=0x1110)
    scenario(radio_error=-1)
    scenario(allocation_failure=True)
    scenario(send_error=-1)
    print("PASS: compiled native ABI, NVS guard, packet validation, PING/PONG, deduplication, timeout, send failure, cleanup")
