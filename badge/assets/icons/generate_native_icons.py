#!/usr/bin/env python3
"""Generate native LVGL RGB565A8 image descriptors from the badge icon PNGs.

The native factory extension cannot depend on LittleFS app assets. This script
therefore converts the checked-in 42x42 RGBA PNGs into const data linked into
its existing DROM growth page. It uses only the Python standard library so the
pinned native build has no additional package dependency.
"""

from __future__ import annotations

import argparse
import hashlib
import struct
import sys
import zlib
from dataclasses import dataclass
from pathlib import Path


HERE = Path(__file__).resolve().parent
OUTPUT = HERE.parent.parent / "native" / "generated_icons.h"
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
WIDTH = 42
HEIGHT = 42
NATIVE_SIZE = 28
LV_IMAGE_HEADER_MAGIC = 0x19
LV_COLOR_FORMAT_RGB565A8 = 0x14


@dataclass(frozen=True)
class RgbaImage:
    width: int
    height: int
    pixels: bytes


def paeth(left: int, above: int, upper_left: int) -> int:
    estimate = left + above - upper_left
    left_distance = abs(estimate - left)
    above_distance = abs(estimate - above)
    upper_left_distance = abs(estimate - upper_left)
    if left_distance <= above_distance and left_distance <= upper_left_distance:
        return left
    if above_distance <= upper_left_distance:
        return above
    return upper_left


def load_rgba_png(path: Path) -> RgbaImage:
    data = path.read_bytes()
    if not data.startswith(PNG_SIGNATURE):
        raise ValueError(f"{path} is not a PNG")

    position = len(PNG_SIGNATURE)
    header = None
    compressed = bytearray()
    while position < len(data):
        if position + 12 > len(data):
            raise ValueError(f"truncated PNG chunk in {path}")
        size, = struct.unpack_from(">I", data, position)
        chunk_type = data[position + 4:position + 8]
        chunk_data = data[position + 8:position + 8 + size]
        chunk_crc = data[position + 8 + size:position + 12 + size]
        if len(chunk_data) != size or len(chunk_crc) != 4:
            raise ValueError(f"truncated PNG chunk in {path}")
        expected_crc = zlib.crc32(chunk_type)
        expected_crc = zlib.crc32(chunk_data, expected_crc) & 0xFFFFFFFF
        actual_crc, = struct.unpack(">I", chunk_crc)
        if actual_crc != expected_crc:
            raise ValueError(f"PNG CRC mismatch in {path}")
        position += size + 12

        if chunk_type == b"IHDR":
            header = struct.unpack(">IIBBBBB", chunk_data)
        elif chunk_type == b"IDAT":
            compressed.extend(chunk_data)
        elif chunk_type == b"IEND":
            break

    if header is None:
        raise ValueError(f"missing PNG header in {path}")
    width, height, depth, color_type, compression, filtering, interlace = header
    if (width, height) != (WIDTH, HEIGHT):
        raise ValueError(f"{path} must be {WIDTH}x{HEIGHT}, got {width}x{height}")
    if (depth, color_type, compression, filtering, interlace) != (8, 6, 0, 0, 0):
        raise ValueError(f"{path} must be non-interlaced 8-bit RGBA")

    packed = zlib.decompress(bytes(compressed))
    stride = width * 4
    if len(packed) != height * (stride + 1):
        raise ValueError(f"unexpected decoded PNG size in {path}")

    pixels = bytearray(width * height * 4)
    previous = bytearray(stride)
    source = 0
    for row in range(height):
        filter_type = packed[source]
        source += 1
        scanline = bytearray(packed[source:source + stride])
        source += stride
        for column in range(stride):
            left = scanline[column - 4] if column >= 4 else 0
            above = previous[column]
            upper_left = previous[column - 4] if column >= 4 else 0
            if filter_type == 1:
                scanline[column] = (scanline[column] + left) & 0xFF
            elif filter_type == 2:
                scanline[column] = (scanline[column] + above) & 0xFF
            elif filter_type == 3:
                scanline[column] = (scanline[column] + ((left + above) // 2)) & 0xFF
            elif filter_type == 4:
                scanline[column] = (scanline[column] + paeth(left, above, upper_left)) & 0xFF
            elif filter_type != 0:
                raise ValueError(f"unsupported PNG filter {filter_type} in {path}")
        pixels[row * stride:(row + 1) * stride] = scanline
        previous = scanline
    return RgbaImage(width, height, bytes(pixels))


def alpha_bounds(image: RgbaImage) -> tuple[int, int, int, int]:
    visible = [
        (index % image.width, index // image.width)
        for index in range(image.width * image.height)
        if image.pixels[index * 4 + 3]
    ]
    if not visible:
        raise ValueError("source icon has no visible pixels")
    xs = [point[0] for point in visible]
    ys = [point[1] for point in visible]
    return min(xs), min(ys), max(xs) + 1, max(ys) + 1


def resized_crop(image: RgbaImage, bounds: tuple[int, int, int, int],
                 width: int, height: int) -> RgbaImage:
    left, top, right, bottom = bounds
    source_width = right - left
    source_height = bottom - top
    result = bytearray(width * height * 4)
    for y in range(height):
        source_y = top + y * source_height // height
        for x in range(width):
            source_x = left + x * source_width // width
            source = (source_y * image.width + source_x) * 4
            target = (y * width + x) * 4
            result[target:target + 4] = image.pixels[source:source + 4]
    return RgbaImage(width, height, bytes(result))


def alpha_over(target: bytearray, target_width: int, layer: RgbaImage,
               target_x: int, target_y: int) -> None:
    for y in range(layer.height):
        for x in range(layer.width):
            source = (y * layer.width + x) * 4
            red, green, blue, alpha = layer.pixels[source:source + 4]
            if alpha == 0:
                continue
            target_offset = ((target_y + y) * target_width + target_x + x) * 4
            if alpha == 255:
                target[target_offset:target_offset + 4] = bytes((red, green, blue, alpha))
                continue
            old_red, old_green, old_blue, old_alpha = target[target_offset:target_offset + 4]
            inverse = 255 - alpha
            output_alpha = alpha + old_alpha * inverse // 255
            if output_alpha == 0:
                continue
            target[target_offset] = (red * alpha + old_red * old_alpha * inverse // 255) // output_alpha
            target[target_offset + 1] = (green * alpha + old_green * old_alpha * inverse // 255) // output_alpha
            target[target_offset + 2] = (blue * alpha + old_blue * old_alpha * inverse // 255) // output_alpha
            target[target_offset + 3] = output_alpha


def build_bun() -> RgbaImage:
    """Stack the checked-in top/bottom bun art without introducing new shapes."""
    top = load_rgba_png(HERE / "ing_bun_top.png")
    bottom = load_rgba_png(HERE / "ing_bun_bottom.png")
    top_layer = resized_crop(top, alpha_bounds(top), 36, 20)
    bottom_layer = resized_crop(bottom, alpha_bounds(bottom), 36, 12)
    pixels = bytearray(WIDTH * HEIGHT * 4)
    alpha_over(pixels, WIDTH, top_layer, 3, 5)
    alpha_over(pixels, WIDTH, bottom_layer, 3, 25)
    return RgbaImage(WIDTH, HEIGHT, bytes(pixels))


def encode_rgb565a8(image: RgbaImage) -> bytes:
    colors = bytearray(image.width * image.height * 2)
    alpha = bytearray(image.width * image.height)
    for index in range(image.width * image.height):
        red, green, blue, opacity = image.pixels[index * 4:index * 4 + 4]
        rgb565 = ((red >> 3) << 11) | ((green >> 2) << 5) | (blue >> 3)
        struct.pack_into("<H", colors, index * 2, rgb565)
        alpha[index] = opacity
    return bytes(colors + alpha)


def native_icon_data() -> list[tuple[str, str, bytes]]:
    definitions = [
        ("bun", "ing_bun_top.png + ing_bun_bottom.png (stacked)", build_bun()),
        ("raw_meat", "ing_meat.png", load_rgba_png(HERE / "ing_meat.png")),
        ("chopped_meat", "ing_meat_chopped.png", load_rgba_png(HERE / "ing_meat_chopped.png")),
        ("cooked_meat", "ing_meat_cooked.png", load_rgba_png(HERE / "ing_meat_cooked.png")),
        ("burnt_meat", "ing_meat_burnt.png", load_rgba_png(HERE / "ing_meat_burnt.png")),
        ("lettuce", "ing_lettuce.png", load_rgba_png(HERE / "ing_lettuce.png")),
        ("chopped_lettuce", "ing_lettuce_chopped.png", load_rgba_png(HERE / "ing_lettuce_chopped.png")),
        ("cheese", "ing_cheese.png", load_rgba_png(HERE / "ing_cheese.png")),
        ("chopped_cheese", "ing_cheese_chopped.png", load_rgba_png(HERE / "ing_cheese_chopped.png")),
        ("plate", "station_plate.png", load_rgba_png(HERE / "station_plate.png")),
    ]
    # ponytail: 28px assets fit the stock runtime mapping; larger art needs a verified mapping change.
    return [(name, source, encode_rgb565a8(resized_crop(
        image, (0, 0, WIDTH, HEIGHT), NATIVE_SIZE, NATIVE_SIZE)))
        for name, source, image in definitions]


def c_bytes(data: bytes) -> str:
    rows = []
    for offset in range(0, len(data), 16):
        rows.append("    " + ", ".join(f"0x{value:02x}" for value in data[offset:offset + 16]) + ",")
    return "\n".join(rows)


def build_header() -> str:
    parts = [
        "/* GENERATED by badge/assets/icons/generate_native_icons.py.",
        "   Edit the PNG sources or generator, then regenerate; do not hand-edit. */",
        "#ifndef HTN26_GENERATED_ICONS_H",
        "#define HTN26_GENERATED_ICONS_H",
        "",
    ]
    for name, source, data in native_icon_data():
        digest = hashlib.sha256(data).hexdigest()
        parts.extend([
            f"/* {name}: {source}; RGB565A8 sha256={digest} */",
            f"static const u8 native_icon_{name}_data[{len(data)}] = {{",
            c_bytes(data),
            "};",
            f"static const NativeImage native_icon_{name} = {{",
            f"    {{{LV_IMAGE_HEADER_MAGIC}, {LV_COLOR_FORMAT_RGB565A8}, 0, {NATIVE_SIZE}, {NATIVE_SIZE}, {NATIVE_SIZE * 2}, 0}},",
            f"    {len(data)}, native_icon_{name}_data, 0",
            "};",
            "",
        ])
    parts.extend(["#endif", ""])
    return "\n".join(parts)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="fail if the committed header is stale")
    args = parser.parse_args()
    generated = build_header()
    if args.check:
        if not OUTPUT.is_file() or OUTPUT.read_text(encoding="utf-8") != generated:
            print(f"stale generated file: {OUTPUT}", file=sys.stderr)
            print("run: python badge/assets/icons/generate_native_icons.py", file=sys.stderr)
            raise SystemExit(1)
        print(f"PASS: {OUTPUT} matches the PNG sources")
        return
    OUTPUT.write_text(generated, encoding="utf-8", newline="\n")
    print(f"Wrote {OUTPUT} ({len(native_icon_data())} icons, {len(generated.encode())} source bytes)")


if __name__ == "__main__":
    main()
