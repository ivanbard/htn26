"""Execute compiled RV32IMC callbacks with firmware calls stubbed, not hardware."""
import struct
import sys
from pathlib import Path
from build import ROOT, HERE, HOOK, decode

sys.path.insert(0, str(ROOT / ".tools/reverse"))
from unicorn import Uc, UC_ARCH_RISCV, UC_MODE_RISCV32, UC_HOOK_CODE
from unicorn.riscv_const import UC_RISCV_REG_A0, UC_RISCV_REG_A1, UC_RISCV_REG_RA, UC_RISCV_REG_SP, UC_RISCV_REG_PC


def scenario(nvs_error=0, radio_error=0, allocation_failure=False):
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
        a0, a1 = machine.reg_read(UC_RISCV_REG_A0), machine.reg_read(UC_RISCV_REG_A1)
        calls.append(address)
        result = 0
        if address == 0x420385A0:
            result = old_app
        elif address == 0x4203AACE:
            registrations.append(a0)
        elif address == 0x40397474:
            assert (a0, a1) == (1, 16)
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
        else:
            assert address in (0x420A908C, 0x420A90B2, 0x420AE15C,
                               0x420AE11A, 0x420ADDEA, 0x420ADE14, 0x42011252), hex(address)
        machine.reg_write(UC_RISCV_REG_A0, result & 0xFFFFFFFF)
        machine.reg_write(UC_RISCV_REG_PC, machine.reg_read(UC_RISCV_REG_RA))

    cpu.hook_add(UC_HOOK_CODE, callback)
    cpu.emu_start(HOOK, HOOK + 8, count=100000)
    assert cpu.reg_read(UC_RISCV_REG_PC) == HOOK + 8
    assert registrations == ([old_app] if allocation_failure else [old_app, app])
    if allocation_failure:
        return
    table, = struct.unpack("<I", cpu.mem_read(app, 4))

    def invoke(slot, second=0):
        entry, = struct.unpack("<I", cpu.mem_read(table + slot, 4))
        cpu.reg_write(UC_RISCV_REG_A0, app)
        cpu.reg_write(UC_RISCV_REG_A1, second)
        cpu.reg_write(UC_RISCV_REG_RA, 0x42000000)
        cpu.emu_start(entry, 0x42000000, count=100000)
        assert cpu.reg_read(UC_RISCV_REG_PC) == 0x42000000
        return cpu.reg_read(UC_RISCV_REG_A0)

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
        assert ("Radio error\nSee serial log" if radio_error else "Radio ready\nNative client idle") in texts
    for _ in range(250):
        invoke(0x5C)
    assert "idle" in stages
    assert calls.count(0x420109C6) == (0 if nvs_error else 1)
    invoke(0x58)
    assert 0x42011252 in calls and stages[-1] == "exit"
    assert cpu.mem_read(app + 4, 12) == bytes(12)


if __name__ == "__main__":
    scenario()
    scenario(nvs_error=0x110D)
    scenario(nvs_error=0x1110)
    scenario(radio_error=-1)
    scenario(allocation_failure=True)
    print("PASS: compiled hook, native ABI, radio success/failure, NVS fail-closed, heartbeat, cleanup, allocation failure")
