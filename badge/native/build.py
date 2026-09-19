"""Build a version-pinned factory-only extension. Never accesses a serial port."""
import argparse
import hashlib
import json
from pathlib import Path
import struct
import subprocess

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
IMAGE_HASH = "b2fc91dbcb0159d79c3b15e987301979f466163a819c7a90aff0e806ed943380"
PARTITION_HASH = "1b5d9ae883c303de49bfef57dd30b1967e6e13c291a62a953532cda8c047fa7d"
TABLE_HASH = "5cc6ed9fb7498d7741d0737edb12d9c610f7306b8e021e2e75f9e9f04822a9f9"
FACTORY = 0x10000
CAPACITY = 0x2A0000
HOOK = 0x4200A81C
HOOK_BYTES = bytes.fromhex("efd05258ef00e32a")
TEXT = 0x4212C720
RODATA = 0x3C268760


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def encode(header, segments):
    result = bytearray(header)
    checksum = 0xEF
    for address, data in segments:
        require(len(data) % 4 == 0, "Unaligned segment length")
        result.extend(struct.pack("<II", address, len(data)))
        result.extend(data)
        for value in data:
            checksum ^= value
    result.extend(bytes(15 - len(result) % 16))
    result.append(checksum)
    result.extend(hashlib.sha256(result).digest())
    return bytes(result)


def decode(image):
    require(len(image) >= 24 and image[0] == 0xE9, "Invalid ESP image header")
    require(image[1] == 6 and image[23] == 1, "Unexpected segment/hash format")
    header, segments, offsets = image[:24], [], []
    position = 24
    for _ in range(header[1]):
        require(position + 8 <= len(image), "Truncated segment header")
        address, size = struct.unpack_from("<II", image, position)
        position += 8
        require(size % 4 == 0 and position + size <= len(image), "Invalid segment size")
        segments.append((address, image[position:position + size]))
        offsets.append(position)
        position += size
    end = (position // 16 + 1) * 16 + 32
    require(end <= len(image), "Truncated checksum/digest")
    require(encode(header, segments) == image[:end], "Image checksum, digest, or padding mismatch")
    for (address, _), offset in zip(segments, offsets):
        if address in (0x3C130020, 0x42000020):
            require((FACTORY + offset) % 0x10000 == address % 0x10000, "MMU alignment mismatch")
    return header, segments, end


def load_stock(path):
    dump = path.read_bytes()
    require(len(dump) == 0x400000, "Expected the full 4 MiB backup")
    require(sha(dump[0x8000:0x9000]) == TABLE_HASH, "Partition table differs from inspected badge")
    image = dump[FACTORY:FACTORY + CAPACITY]
    require(sha(image) == PARTITION_HASH, "Factory partition differs from inspected backup")
    header, segments, end = decode(image)
    require(sha(image[:end]) == IMAGE_HASH, "Factory firmware differs from inspected build")
    return header, segments, image[:end]


def elf_payload(path):
    data = path.read_bytes()
    require(data[:7] == b"\x7fELF\x01\x01\x01", "Expected ELF32 little-endian")
    require(struct.unpack_from("<H", data, 18)[0] == 243, "Expected RISC-V ELF")
    entry, = struct.unpack_from("<I", data, 24)
    start, = struct.unpack_from("<I", data, 32)
    size, count, names_index = struct.unpack_from("<HHH", data, 46)
    require(size == 40, "Unexpected ELF section header size")
    sections = [struct.unpack_from("<10I", data, start + i * size) for i in range(count)]
    names = sections[names_index]
    strings = data[names[4]:names[4] + names[5]]
    result = {}
    for section in sections:
        name = strings[section[0]:].split(b"\0", 1)[0].decode()
        if section[2] & 2 and section[5]:
            require(name in (".text", ".rodata"), "Unexpected allocated ELF section: " + name)
            require(section[1] == 1, "Expected initialized ELF payload")
            result[name] = (section[3], data[section[4]:section[4] + section[5]])
    require(entry == TEXT and result[".text"][0] == TEXT, "Hook entry moved")
    require(result[".rodata"][0] == RODATA, "DROM payload moved")
    return result[".text"][1], result[".rodata"][1]


def hook_bytes():
    # AUIPC ra, high; JALR ra, low(ra). Return PC remains HOOK + 8.
    delta = TEXT - HOOK
    high = (delta + 0x800) >> 12
    low = delta - (high << 12)
    return struct.pack("<II", (high << 12) | (1 << 7) | 0x17,
                       ((low & 0xFFF) << 20) | (1 << 15) | (1 << 7) | 0x67)


def extend(header, segments, text, rodata):
    require(len(text) <= 0x38E0 and len(rodata) <= 0x10000, "Payload exceeds mapped space")
    patched = [(address, bytes(data)) for address, data in segments]
    require(patched[0][0] + len(patched[0][1]) == RODATA, "Unexpected DROM end")
    require(patched[2][0] + len(patched[2][1]) == TEXT, "Unexpected IROM end")
    offset = HOOK - patched[2][0]
    require(patched[2][1][offset:offset + 8] == HOOK_BYTES, "Original hook instructions differ")
    code = bytearray(patched[2][1])
    code[offset:offset + 8] = hook_bytes()
    code.extend(text)
    code.extend(bytes(-len(code) % 4))
    patched[2] = (patched[2][0], bytes(code))
    patched[0] = (patched[0][0], patched[0][1] + rodata.ljust(0x10000, b"\0"))
    candidate = encode(header, patched)
    require(len(candidate) <= CAPACITY, "Factory partition overflow")
    _, checked, end = decode(candidate)
    require(end == len(candidate), "Unexpected trailing image data")
    # Verify original loaded contents, not file offsets (later segments move).
    for i, ((old_address, old), (new_address, new)) in enumerate(zip(segments, checked)):
        require(old_address == new_address, "Stock virtual address changed")
        expected = bytearray(old)
        if i == 2:
            expected[offset:offset + 8] = hook_bytes()
        require(new[:len(old)] == expected, "Unapproved stock segment change")
        if i not in (0, 2):
            require(new == old, "Stock RAM/RTC segment changed")
    return candidate


def build(dump, zig, output):
    header, segments, stock = load_stock(dump)
    require(encode(header, segments) == stock, "Stock round-trip failed")
    output.mkdir(parents=True, exist_ok=True)
    elf = output / "overcooked.elf"
    command = [str(zig), "cc", "-target", "riscv32-freestanding", "-mcpu=generic_rv32+m+c",
               "-mabi=ilp32", "-msmall-data-limit=0", "-mno-relax", "-Oz",
               "-ffreestanding", "-fno-builtin", "-fno-stack-protector",
               "-fno-unwind-tables", "-fno-asynchronous-unwind-tables", "-nostdlib",
               "-Wall", "-Wextra", "-Werror", "-Wl,-e,register_overcooked", "-Wl,-T," + str(HERE / "payload.ld"),
               str(HERE / "overcooked.c"), "-o", str(elf)]
    subprocess.run(command, check=True)
    text, rodata = elf_payload(elf)
    candidate = extend(header, segments, text, rodata)
    (output / "stock-factory.bin").write_bytes(stock)
    (output / "stock-factory-partition.bin").write_bytes(dump.read_bytes()[FACTORY:FACTORY + CAPACITY])
    (output / "overcooked-factory.bin").write_bytes(candidate)
    report = {
        "stock_sha256": sha(stock), "candidate_sha256": sha(candidate),
        "stock_bytes": len(stock), "candidate_bytes": len(candidate),
        "factory_capacity": CAPACITY, "remaining_bytes": CAPACITY - len(candidate),
        "payload_code_bytes": len(text), "payload_rodata_bytes": len(rodata),
        "drom_growth_bytes": 0x10000, "permanent_app_object_bytes": 128,
        "hook_virtual_address": hex(HOOK), "hook_old": HOOK_BYTES.hex(),
        "hook_new": hook_bytes().hex(), "stock_round_trip": "byte-identical",
        "stock_loaded_segments": "identical except eight-byte registration hook",
        "hardware_tested": False,
        "compiler": subprocess.check_output([str(zig), "version"], text=True).strip(),
        "source_sha256": sha((HERE / "overcooked.c").read_bytes()),
        "linker_sha256": sha((HERE / "payload.ld").read_bytes()),
    }
    (output / "verification.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dump", type=Path, default=ROOT / "htn_badge_full.bin")
    parser.add_argument("--zig", type=Path, default=ROOT / ".tools/native/ziglang/zig.exe")
    parser.add_argument("--output", type=Path, default=HERE / "build")
    args = parser.parse_args()
    build(args.dump.resolve(), args.zig.resolve(), args.output.resolve())
