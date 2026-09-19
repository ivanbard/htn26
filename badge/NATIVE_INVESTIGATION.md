# Native Overcooked: binary investigation

Inspection date: 2026-09-19. The initial investigation was read-only; subsequent
native implementation and hardware validation are recorded in `native/`.
Addresses below apply only to the inspected build. Function names are recovered
roles, not original symbols, unless explicitly identified as embedded strings.

## Baseline

Both inputs are 4,194,304-byte full-flash dumps:

| Input | SHA-256 |
| --- | --- |
| `htn_badge_full.bin` | `d8080d99615a119a6e115d90c6ba0272c6e824a664aab98af58e1096ad8231b4` |
| `htn_badge_full_2.bin` | `40c80dfa9c9d3b95931e4a2832ba9a7d0e3822e4a6fb69f82edb4706b52c88af` |

Factory contents match. Only storage sectors 0x2B1000 and 0x2BF000 differ.
Image descriptor: ESP32-C3, project `hello_world`, version
`v0.1.2-392-gd3089c4`, IDF `v5.5.3-dirty`, built Sep 17 2026 at 17:39:16.
Embedded ELF SHA-256:
`4c3d3960c78581d695bab152c42e83f65c7df9e9b1859379cdcea60597690301`.
Readback from COM4 confirmed the original factory partition and partition table
matched these dumps before installing the native extension.

| Partition | Offset | Size |
| --- | --- | --- |
| nvs | 0x9000 | 0x4000 |
| phy_init | 0xD000 | 0x1000 |
| factory | 0x10000 | 0x2A0000 |
| storage | 0x2B0000 | 0x140000 |

The six-segment application image is 0x2876C0 (2,651,840) bytes including its
appended digest. Segment XOR checksum and SHA-256 both validate. Factory has
100,672 bytes remaining; this is flash capacity, not RAM or automatically
executable space.

| Segment | Flash data offset | Load/map address | Length |
| --- | --- | --- | --- |
| 0 | 0x10020 | 0x3C130020 | 0x138740 |
| 1 | 0x148768 | 0x3FC99C00 | 0x78B0 |
| 2 | 0x150020 | 0x42000020 | 0x12C700 |
| 3 | 0x27C728 | 0x3FCA14B0 | 0x1394 |
| 4 | 0x27DAC4 | 0x40380000 | 0x19BAC |
| 5 | 0x297678 | 0x50000000 | 0x20 |

## Native registration and Share

Directly observed in RV32 compressed-instruction disassembly:

- Boot calls Share's singleton getter at `0x4203C918` from `0x4200A674`,
  then the common registration routine `0x4203AACE` at `0x4200A678`.
- The getter returns the existing C++ object at `0x3FC9E444`. Its initialized
  first word is the virtual-table address `0x3C1570D8`.
- Registration appends an app pointer to a dynamic array/vector. Native apps
  are not registered by adding a Lua manifest or a filesystem executable.
- `0x4203A44C` looks up apps by calling each object's identifier method and
  comparing strings. `0x4203A4AC` handles switching apps.
- Share name method `0x4203BD54` returns `Share`; ID method `0x4203BD72`
  returns `share`.
- Virtual-table offset `+0x2C` points to `0x4203BD80`, which returns true.
  The switch routine calls this slot before its `reboot-enter` branch.
- Share entry at slot `+0x54` is `0x4203CC9E`; exit at `+0x58` is
  `0x4203CBB2`; tick/update at `+0x5C` is `0x4203DB1C`; button handling at
  `+0x60` is `0x4203E3FC`. These corrected offsets follow registry call sites.
  Slot `+0x48` is a Home-confirmation policy, not the button callback.

The native implementation supplies all 25 virtual slots. Stateful Share
callbacks are replaced; only its icon and stateless conventions are reused.
Registry call sites and launcher order reconciliation were checked before
constructing the new object; compiled callback behavior also has emulator tests.

## Reboot lifecycle

The common switch routine checks the destination's reboot method when leaving
the launcher. It calls `0x42039E54`, which obtains the app ID and calls
`0x42039DD2`. That function writes the reboot intent through `0x42039C04`,
then calls the restart routine at `0x42000BAC` on success.

Intent is a small file, `/littlefs/config/reboot.cfg`, with `target=` and
`focus=` lines. Exactly one value must be nonempty; each is limited to 63 bytes.
Entering Share sets target `share`; returning sets an empty target and an app
ID as focus. This is an intentional stock filesystem write, not an NVS target.

Boot reads and consumes the file through `0x42039F0A`; it checks reset reason
against 3 (software reset), deletes the consumed file, and resolves the target
against the app registry. Missing targets fall back to normal boot. The
direct-start branch calls registry initialization with a one-shot bypass flag
so the app is entered without another reboot.

Exit runs app cleanup, NFC stop, and common radio stop at `0x42011252`.
When returning to the launcher after active NFC/radio use, it calls
`0x42039E7E` with the departing app ID to persist launcher focus and restart.
Reboot persistence failure has an existing direct-launch fallback.

Hardware confirms the existing lifecycle addresses registered ID `overcooked`:
launcher selection logs `reboot-enter overcooked`, and Home exit stops radio
then logs `reboot to launcher focus=overcooked`. The persistence-failure path
still falls back to direct entry, so the app reports radio errors without retries.

## Radio behavior

Share entry builds its UI/menu; it does not immediately enable the radio.
Send/receive actions invoke the separate transfer layer (`share_xfer`).
The receive path `0x4205782C` calls setup at `0x42055DFC`, which configures
scan timing, calls radio enable `0x420109C6`, then pauses advertising through
`0x42010CC2`. Other transfer paths use the setup routine at `0x42055DC6`.

Radio enable calls lazy initialization `0x42010416` as necessary. This logs
free/largest heap, initializes NVS and NimBLE, installs reset/sync callbacks,
starts the host task, and waits for synchronization. Enable configures extended
advertising, installs an initial payload, starts advertising and scanning,
and marks the radio running. Success is logged as `BLE radio ready`.

Share exit calls transfer cleanup at `0x42057AEE`, removes its temporary
transfer files, and clears UI state. Common registry cleanup subsequently
stops scanning/advertising and clears radio handlers through `0x42011252`.
That common stop routine does not perform full NimBLE/controller deinit;
the subsequent reboot provides the clean memory reset.

This supports reusing the BLE advertising HAL, without Share's file-transfer
protocol or a new BLE/GATT stack. Direct Pi participation and the exact custom
packet API still require decoding. There is no demonstrated Wi-Fi app path;
generic Wi-Fi error strings are insufficient evidence.

### Existing NVS recovery branch

At `0x4201045A` radio init calls `0x42101718` (NVS initialization). Errors
0x110D and 0x1110 branch to `0x4201051E`, which calls `0x421018CA` and retries.
That function selects `nvs` and calls `0x4210186C`, whose disassembly finds the
NVS partition and erases its full size. The implementation matches IDF's
`nvs_flash_erase` / `nvs_flash_erase_partition` source.

This is stock behavior, not an action performed during this investigation.
Before invoking the HAL from Overcooked, validate a fail-closed preflight of
NVS initialization so an NVS error is displayed/logged without reaching that
recovery branch. Do not silently reuse an erasure path or change stock Share.

Reference: https://raw.githubusercontent.com/espressif/esp-idf/v5.5.3/components/nvs_flash/src/nvs_api.cpp

## Other located components

| Component | Evidence / location |
| --- | --- |
| Launcher | singleton getter `0x4202FD08`, name method `0x4202ED12` |
| Sync | getter `0x42043354`, ID method `0x4204339C`; boot registration at `0x4200A684` |
| My Badge | name method `0x42014A1A`, string `My Badge` |
| Buttons | embedded `main/hal/hal_buttons.cpp`; boot init call to `0x4200B254` |
| Display | embedded `main/hal/hal_display.cpp`; boot call to `0x4200E408`; LVGL9 port present |
| LEDs | `hal_lights`, boot call to `0x4200F424`, RMT LED-strip driver strings |
| NFC | enable `0x4200FF2E`, stop `0x42010016`, card `0x42010062`, clear `0x420100FC`, NDEF Text `0x42010138` |
| Accelerometer | cached XYZ read `0x4200AED4`; Update 1.1 uses integer IEEE-754 shake/tap thresholds pending calibration |
| Lua apps | boot passes `/littlefs/apps` to `0x420547FE`; native registry remains present |
| Heap | recovered free/largest routines `0x420023A6` / `0x420024AC` |

Registry heap logging uses capability mask 0x804, while radio logging uses
0x1000. Compare like-for-like masks at every Overcooked/Share measurement.
Runtime measurements are recorded in `native/HARDWARE_RESULTS.md`.

## Milestone 1 implementation update

The native shell and hash-pinned builder now live in `native/`. The build
replays the final stock registration pair through an eight-byte AUIPC/JALR
hook, then adds Overcooked before Lua discovery and launcher order setup.
The existing order reconciliation at `0x4204FCEE` includes unlisted category-0
apps, so the new app uses category 0 without changing the launcher.

New constants extend DROM by one 64 KiB page. Code extends existing IROM
within its final MMU page. Original loaded addresses and initialized RAM/RTC
contents stay unchanged. This costs a flash page to preserve alignment,
not 64 KiB of RAM. The app object uses 16 bytes plus allocator overhead.

The factory tail is not completely erased: bytes at 0x298000 through part of
0x29A000 lie beyond the checked application's end and all loaded segments.
Their provenance is unknown. The builder pins the entire original factory
partition hash and saves an exact factory-partition rollback file. It does
not assume those trailing bytes are executable free space. The expanded
image replaces them as part of its factory-only output.

The candidate passes independent esptool image validation and offline
preservation checks. COM4 access recovered after reconnection. Secure boot and
flash encryption were disabled; no security configuration was changed.
Factory-only flashing and immediate full readback verified every byte outside
factory remained unchanged. Hardware results are recorded separately.

## Milestone 1 approach, without original source

This is a binary-extension route, not a rebuild of the original source.
The prior requirement to build unmodified stock cannot literally be met from
these dumps. Do not label an extracted or repacked image a stock source build.

1. Finish verifying the app ABI, launcher inclusion, input dispatch, minimal
   LVGL calls, heap/log APIs, and NVS preflight against all relevant call sites.
2. Prove image reconstruction reproduces the original factory image exactly.
   Pin any future patcher to the exact input image hash and expected hook bytes.
3. Establish a mapped executable placement within factory, preserving original
   virtual addresses and initialized RAM data. Account for segment alignment,
   image checksums, boot validation, and any signature requirements before
   deciding that the 98 KiB tail can be used. Never treat unused flash as RAM.
4. Compile a tiny app object and full compatible virtual table, add one
   registration through a narrowly scoped boot hook, and retain every existing
   registration. Use ID `overcooked`, name `Overcooked`, reboot policy true.
5. Build the minimal screen; log identical free/largest heap masks at entry,
   before radio, and after radio; initialize the existing HAL only after the
   fail-closed NVS preflight. No Lua VM, NFC, gameplay, or Share transfer buffers.
6. Use existing exit/launcher behavior, including focus restoration. Confirm
   radio callbacks are detached before releasing app state and rebooting.
7. Produce a separate factory-only candidate plus a byte-level change report.
   Verify partition fit and that bootloader/partition/NVS/PHY/storage are absent
   from the flash operation. Present the exact command before any flashing.
8. Hardware gate: repeated enter/exit, radio-ready idle soak, heap comparison
   with Share, and regression checks for launcher, Share transfer, Sync,
   My Badge/identity, and installed Lua apps. Only then proceed to PING/PONG.

Minimum implementation files: one native app
source containing the small ABI adapter; one fixed-address linker description;
one build/patch/verify script with exact input guards. These are implemented in
`native/overcooked.c`, `native/payload.ld`, and `native/build.py`.

## Inspection artifacts

Local ignored `.tools/reverse/firmware.asm` contains RV32IMC disassembly of the
two executable segments, generated with Capstone 5.0.9. `annotated.asm` adds
direct call targets and heuristic LUI/ADDI string references. Annotations are
navigation aids; findings above were checked against raw instructions and
virtual-table words. Neither file is source code or a flashable output.
