"""Offline checks; never opens the badge or modifies the backup."""
import hashlib
import json
import struct
import subprocess
import sys
from build import (ROOT, HERE, FACTORY, CAPACITY, HOOK, HOOK_BYTES, TEXT,
                   ICON_GENERATOR, GENERATED_ICONS, load_stock, encode, decode,
                   extend, elf_payload, hook_bytes, RODATA_LIMIT)


def rejects(action):
    try:
        action()
    except ValueError:
        return
    raise AssertionError("Unsafe input was accepted")


def main():
    subprocess.run([sys.executable, str(ICON_GENERATOR), "--check"], check=True)
    header, segments, stock = load_stock(ROOT / "htn_badge_full.bin")
    assert encode(header, segments) == stock
    assert load_stock(ROOT / "htn_badge_full_2.bin")[2] == stock
    for offset in (0, 1, 24 + 4, 50, len(stock) - 1):
        damaged = bytearray(stock)
        damaged[offset] ^= 1
        rejects(lambda: decode(damaged))
    rejects(lambda: decode(stock[:-1]))
    rejects(lambda: extend(header, segments, bytes(0x38E1), b"test"))
    rejects(lambda: extend(header, segments, b"test", bytes(0x10001)))
    rejects(lambda: extend(header, segments, b"test", bytes(RODATA_LIMIT + 1)))
    rejects(lambda: extend(header, segments, b"test", bytes(55695)))  # Boot-looping icon build.
    altered = list(segments)
    original_code = bytearray(altered[2][1])
    offset = HOOK - altered[2][0]
    original_code[offset] ^= 1
    altered[2] = (altered[2][0], bytes(original_code))
    rejects(lambda: extend(header, altered, b"test", b"test"))
    upper, lower = struct.unpack("<II", hook_bytes())
    immediate = lower >> 20
    if immediate & 0x800:
        immediate -= 0x1000
    assert HOOK + (upper & 0xFFFFF000) + immediate == TEXT
    assert upper & 0xFFF == 0x97 and lower & 0xFFFFF == 0x80E7
    text, constants = elf_payload(HERE / "build/overcooked.elf")
    candidate = extend(header, segments, text, constants)
    assert candidate == (HERE / "build/overcooked-factory.bin").read_bytes()
    new_header, new_segments, size = decode(candidate)
    assert new_header == header and size <= CAPACITY
    for i, ((old_address, old), (new_address, new)) in enumerate(zip(segments, new_segments)):
        assert old_address == new_address
        if i == 0:
            assert new[:len(old)] == old
        elif i == 2:
            assert old[offset:offset + 8] == HOOK_BYTES
            assert new[:offset] == old[:offset]
            assert new[offset + 8:len(old)] == old[offset + 8:]
            assert new[len(old):len(old) + len(text)] == text
        else:
            assert new == old
    # The image is a factory payload, not a full-flash dump or merged image.
    assert len(candidate) < 0x400000 and candidate[:24] == stock[:24]
    rollback = (HERE / "build/stock-factory-partition.bin").read_bytes()
    assert rollback == (ROOT / "htn_badge_full.bin").read_bytes()[FACTORY:FACTORY + CAPACITY]
    report = json.loads((HERE / "build/verification.json").read_text())
    assert report["permanent_app_object_bytes"] == 312
    assert report["native_icon_count"] == 10
    assert report["generated_icons_sha256"] == hashlib.sha256(GENERATED_ICONS.read_bytes()).hexdigest()
    assert report["payload_rodata_bytes"] <= RODATA_LIMIT
    print("PASS: stock round-trip, both backups, generated icons, bounds, hook target, stock preservation, rollback")


if __name__ == "__main__":
    main()
