/* Native extension for v0.1.2-392-gd3089c4 only. See README.md. */
typedef unsigned int u32;
typedef unsigned long usize;
typedef struct App {
    const usize *vtable;
    void *status;
    u32 phase;
    u32 ticks;
} App;

#define FN(address, result, ...) ((result (*)(__VA_ARGS__))(address))
#define PRINT FN(0x4211b726, int, const char *, ...)
#define FREE_HEAP FN(0x420023a6, u32, u32)
#define LARGEST_HEAP FN(0x420024ac, u32, u32)
#define RADIO_START FN(0x420109c6, int, void)
#define RADIO_STOP FN(0x42011252, void, void)
#define LABEL_TEXT FN(0x420ce086, void, void *, const char *)

static void heap(const char *stage) {
    /* Match both the registry and radio masks; do not compare unlike heaps. */
    PRINT("OC_NATIVE|%s|internal8_free=%u|internal8_largest=%u|default_free=%u|default_largest=%u\n",
          stage, FREE_HEAP(0x804), LARGEST_HEAP(0x804),
          FREE_HEAP(0x1000), LARGEST_HEAP(0x1000));
}

static usize zero(App *self) { (void)self; return 0; }
static usize yes(App *self) { (void)self; return 1; }
static usize period(App *self) { (void)self; return 20; }
static const char *name(App *self) { (void)self; return "Overcooked"; }
static const char *short_name(App *self) { (void)self; return "OC"; }
static const char *identifier(App *self) { (void)self; return "overcooked"; }

static void *label(void *screen, const char *text, int y) {
    void *object = FN(0x420ce062, void *, void *)(screen);
    if (!object) return 0;
    LABEL_TEXT(object, text);
    FN(0x420a908c, void, void *, int, int)(object, 12, y);
    FN(0x420a90b2, void, void *, int)(object, 290);
    FN(0x420ae15c, void, void *, const void *, u32)(object, (void *)0x3c24bffc, 0);
    u32 color = FN(0x420bd958, u32, u32)(0xf4f4ef);
    FN(0x420ae11a, void, void *, u32, u32)(object, color, 0);
    return object;
}

static void enter(App *self, void *screen) {
    heap("entry");
    self->ticks = 0;
    self->phase = 1;
    u32 color = FN(0x420bd958, u32, u32)(0x050505);
    FN(0x420addea, void, void *, u32, u32)(screen, color, 0);
    FN(0x420ade14, void, void *, u32, u32)(screen, 255, 0);
    label(screen, "OVERCOOKED", 16);
    self->status = label(screen, "Starting radio...", 76);
    label(screen, "HOME: Apps", 190);
}

static void tick(App *self) {
    if (self->phase == 1) {
        self->phase = 2;
        heap("before_radio");
        /* Stock HAL erases NVS on two initialization errors. Fail closed here.
         * After success, its repeated nvs_flash_init returns ESP_OK without
         * reopening the partition. No erase function is called by this app. */
        int error = FN(0x42101718, int, void)();
        if (error) {
            PRINT("OC_NATIVE|nvs_preflight_failed=%d|radio_not_started\n", error);
            if (self->status) LABEL_TEXT(self->status, "NVS error\nRadio not started");
            self->phase = 3;
            heap("nvs_error");
            return;
        }
        error = RADIO_START();
        heap("after_radio");
        PRINT("OC_NATIVE|radio_result=%d\n", error);
        if (self->status) LABEL_TEXT(self->status, error ? "Radio error\nSee serial log" : "Radio ready\nNative client idle");
        if (error) self->phase = 3;
    }
    if (++self->ticks == 250) {
        self->ticks = 0;
        heap("idle");
    }
}

static void leave(App *self) {
    RADIO_STOP();
    heap("exit");
    self->status = 0;
    self->phase = 0;
    self->ticks = 0;
    /* The registry remembers radio activity before this callback, cleans the
     * screen, releases its UI lock, and reboots with focus=overcooked. */
}

static const usize vtable[25] = {
    (usize)zero, (usize)zero, (usize)name, (usize)short_name,
    (usize)identifier, 0x4203bd68, /* Reuse the stock Share icon for this shell. */
    (usize)zero, (usize)zero, (usize)zero, (usize)zero,
    (usize)zero, (usize)yes,      /* +0x2C: clean reboot on launcher entry. */
    (usize)zero, (usize)zero, (usize)zero, (usize)period,
    (usize)zero, (usize)zero, (usize)zero, (usize)zero, (usize)zero,
    (usize)enter, (usize)leave, (usize)tick, (usize)zero
};

__attribute__((section(".text.hook"), used))
void register_overcooked(void) {
    /* Replay both original instructions replaced by the eight-byte hook. */
    void *original = FN(0x420385a0, void *, void)();
    FN(0x4203aace, void, void *)(original);
    App *app = FN(0x40397474, void *, usize, usize)(1, sizeof(App));
    if (!app) {
        PRINT("OC_NATIVE|registration_failed=no_memory\n");
        return;
    }
    app->vtable = vtable;
    FN(0x4203aace, void, void *)(app);
    PRINT("OC_NATIVE|registered|build=milestone1|object_bytes=%u\n", (u32)sizeof(App));
}
