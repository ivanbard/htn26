ENTRY(register_overcooked)
SECTIONS {
    . = 0x4212c720;
    .text : { KEEP(*(.text.hook)) *(.text*) }
    . = 0x3c268760;
    .rodata : { *(.rodata*) *(.srodata*) }
    .data : { *(.data*) *(.sdata*) }
    .bss : { *(.bss*) *(.sbss*) *(COMMON) }
    ASSERT(SIZEOF(.data) == 0, "Mutable globals need explicit initialization")
    ASSERT(SIZEOF(.bss) == 0, "BSS would overlap stock memory")
    ASSERT(SIZEOF(.rodata) <= 0x10000, "DROM extension exceeds one page")
    ASSERT(SIZEOF(.text) <= 0x38e0, "IROM would reach the stock DROM MMU pages")
    /DISCARD/ : { *(.comment) *(.riscv.attributes) *(.eh_frame*) }
}
