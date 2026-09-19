#!/usr/bin/env python3
"""Interactive, backup-first deployment of the pinned native HTN26 badge image.

This script deliberately never erases flash or writes anything except the
factory application partition at 0x10000. It is intended for NixOS-WSL with
Python, pyserial, esptool, and the repository's pinned Zig tool available.
"""
from __future__ import annotations

import argparse
import hashlib
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
DEFAULT_IMAGE = HERE / "build" / "overcooked-factory.bin"
DEFAULT_BACKUPS = Path.home() / "htn26-badge-backups"
READ_SIZE = 0x2A0000
FACTORY_OFFSET = 0x10000


def run(command: list[str], *, capture: bool = False) -> subprocess.CompletedProcess[str]:
    print("+", " ".join(str(part) for part in command))
    return subprocess.run(command, check=True, text=True, capture_output=capture)


def esptool(port: str, *args: str) -> list[str]:
    return [sys.executable, "-m", "esptool", "--chip", "esp32c3", "--port", port,
            "--before", "no-reset", "--after", "no-reset", *args]


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def ports():
    try:
        from serial.tools import list_ports
    except ImportError as error:
        raise SystemExit(
            "pyserial is required for port discovery. Install it with: "
            "python -m pip install pyserial esptool"
        ) from error
    found = sorted(list_ports.comports(), key=lambda item: item.device)
    if not found:
        raise SystemExit(
            "No serial ports were found. Connect one badge in its bootloader "
            "mode and retry. In WSL this may appear as /dev/ttyS* rather than COM*."
        )
    print("\nConnected serial ports:")
    for index, port in enumerate(found, 1):
        details = [port.description or "unknown device"]
        for value in (port.manufacturer, port.product, port.serial_number):
            if value:
                details.append(value)
        print(f"  {index}. {port.device}: " + " | ".join(details))
        print(f"     {port.hwid}")
    return found


def choose_port() -> str:
    found = ports()
    while True:
        answer = input("Select the badge port number (or q to quit): ").strip()
        if answer.lower() == "q":
            raise SystemExit("Cancelled.")
        try:
            selected = found[int(answer) - 1]
        except (ValueError, IndexError):
            print("Choose one of the displayed port numbers.")
            continue
        print(f"Selected {selected.device}: {selected.description or 'unknown device'}")
        return selected.device


def choose_role() -> str:
    while True:
        answer = input("Deploy role [host/player]: ").strip().lower()
        if answer in {"host", "player"}:
            return answer
        if answer in {"slave", "p"}:
            return "player"
        print("Enter host or player.")


def build_image(image: Path, skip_build: bool) -> None:
    if not skip_build:
        run([sys.executable, str(HERE / "build.py")])
    if not image.is_file():
        raise SystemExit(f"Native image not found: {image}\nBuild it first or pass --image.")
    if image.stat().st_size > READ_SIZE:
        raise SystemExit(f"Image is too large for the factory readback boundary: {image.stat().st_size:#x}")
    print(f"Candidate image: {image} ({image.stat().st_size} bytes)")
    print(f"Candidate SHA-256: {sha256(image)}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", type=Path, default=DEFAULT_IMAGE)
    parser.add_argument("--backup-root", type=Path, default=DEFAULT_BACKUPS)
    parser.add_argument("--skip-build", action="store_true")
    args = parser.parse_args()

    port = choose_port()
    role = choose_role()
    image = args.image.resolve()
    build_image(image, args.skip_build)

    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup = args.backup_root.expanduser().resolve() / f"{stamp}-{role}-{port.replace('/', '_')}"
    backup.mkdir(parents=True, exist_ok=False)
    print(f"Backups will be stored in: {backup}")

    print("\nSecurity information (read-only check):")
    run(esptool(port, "get-security-info"))
    print("\nVerify this badge matches the expected inspected security state before continuing.")
    if input("Continue with fresh backups? [y/N] ").strip().lower() != "y":
        raise SystemExit("Cancelled before backup.")

    run(esptool(port, "read-flash", "0x0", "0x400000", str(backup / "full-before.bin")))
    run(esptool(port, "read-flash", "0x8000", "0x1000", str(backup / "partition-table-before.bin")))
    run(esptool(port, "read-flash", "0x10000", "0x2A0000", str(backup / "factory-before.bin")))
    print("Backup hashes:")
    for path in sorted(backup.glob("*.bin")):
        print(f"  {path.name}: {sha256(path)}")

    print("\nSAFETY CHECK")
    print(f"This will write ONLY the factory application at 0x10000 on {port} as {role}.")
    print("It will not erase flash, write the bootloader, write the partition table, or change security settings.")
    confirmation = input("Type FLASH to continue: ").strip()
    if confirmation != "FLASH":
        raise SystemExit("Cancelled before flash.")

    run(esptool(port, "--baud", "460800", "write-flash", "0x10000", str(image)))
    after = backup / "factory-after.bin"
    run(esptool(port, "read-flash", "0x10000", "0x2A0000", str(after)))
    candidate = image.read_bytes()
    readback = after.read_bytes()
    if readback[:len(candidate)] != candidate:
        raise SystemExit("Readback mismatch: do not boot this badge; retain the backups for recovery.")
    print(f"Readback prefix matches candidate ({len(candidate)} bytes). SHA-256: {sha256(after)}")

    print("\nDeployment complete. Do not mix native and Lua badges in one round.")
    if role == "host":
        print("On the badge: open Overcooked, press START for host mode, then confirm HTN26|GW|UP|0|0.")
    else:
        print("On the badge: open Overcooked, press A, choose a unique player number with LEFT/RIGHT, then press A.")
    print(f"Keep the per-device rollback files at: {backup}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except subprocess.CalledProcessError as error:
        print(f"Command failed with exit code {error.returncode}.", file=sys.stderr)
        raise
