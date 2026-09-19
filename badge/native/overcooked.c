/* Native extension for v0.1.2-392-gd3089c4 only. See README.md. */
typedef unsigned int u32;
typedef unsigned long usize;
typedef unsigned char u8;
typedef struct App {
    const usize *vtable;
    void *status;
    u32 phase;
    u32 ticks;
    void *info;
    u32 active, inbox_full;
    char inbox[22];
    u8 peer[6];
    int rssi;
    u32 dropped, sent, received, errors, wait_ticks, advertise_ticks, pulse_ticks;
    u32 attempts, sequence;
    char pending[22], last[22];
    u8 last_peer[6];
} App;
_Static_assert(sizeof(App) == 148, "Update heap report when app size changes");

#define EVENT_BYTES 21
#define ACK_BYTES 17
#define WAIT_TICKS 150
#define ACK_TICKS 100
#define MAX_ATTEMPTS 3

#define FN(address, result, ...) ((result (*)(__VA_ARGS__))(address))
#define PRINT FN(0x4211b726, int, const char *, ...)
#define FREE_HEAP FN(0x420023a6, u32, u32)
#define LARGEST_HEAP FN(0x420024ac, u32, u32)
#define RADIO_START FN(0x420109c6, int, void)
#define RADIO_STOP FN(0x42011252, void, void)
#define RADIO_SEND FN(0x42010c54, int, const void *, usize)
#define RADIO_PAUSE FN(0x42010cc2, int, void)
#define RADIO_RESUME FN(0x42010d36, int, void)
#define RADIO_HANDLER FN(0x42011330, void, const usize *)
#define FORMAT FN(0x4211bc16, int, char *, usize, const char *, ...)
#define LED FN(0x4200f4ca, void, u32, u32, u32, u32)
#define LED_SHOW FN(0x4200f58a, void, void)
#define LED_CLEAR FN(0x4200f54a, void, void)
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

static int equal(const void *left, const void *right, usize size) {
    const u8 *a = left, *b = right;
    for (usize i = 0; i < size; ++i) if (a[i] != b[i]) return 0;
    return 1;
}

/* ESP32-C3 has no A extension. Aligned 32-bit accesses are indivisible;
 * fences publish the single-producer/single-consumer slot without libatomic. */
static u32 acquire(volatile u32 *word) {
    u32 value = *word;
    __asm__ volatile("fence r, rw" ::: "memory");
    return value;
}
static void release(volatile u32 *word, u32 value) {
    __asm__ volatile("fence rw, w" ::: "memory");
    *word = value;
}

static void copy(void *target, const void *source, usize size) {
    u8 *a = target; const u8 *b = source;
    for (usize i = 0; i < size; ++i) a[i] = b[i];
}

static int sequence(const u8 *value) {
    for (int i = 0; i < 8; ++i) if (value[i] < '0' || value[i] > '9') return 0;
    return 1;
}

/* NimBLE task: copy only. UI and transmission stay on the app task.
 * ponytail: one pending receive slot; add a bounded queue only if measured drops
 * justify it. Repeated advertising supplies another chance after a full slot. */
static void receive(const usize *capture, const u8 **peer, const signed char *rssi,
                    const u8 **data, const usize *size) {
    App *self = (App *)capture[0];
    if (!acquire(&self->active)) return;
    const u8 *p = *data;
    int event = *size == EVENT_BYTES && equal(p, "OC1|", 4) && sequence(p + 4) &&
                equal(p + 12, "|N|I:MEAT", 9);
    int ack = *size == ACK_BYTES && equal(p, "OC1|", 4) && sequence(p + 4) &&
              equal(p + 12, "|A|OK", 5);
    if (!event && !ack) return;
    if (acquire(&self->inbox_full)) { ++self->dropped; return; }
    for (int i = 0; i < 22; ++i) self->inbox[i] = 0;
    copy(self->inbox, p, *size);
    copy(self->peer, *peer, 6); self->rssi = *rssi;
    release(&self->inbox_full, 1);
}

static void signal(App *self, int error, int sending) {
    /* Stock gamma/scaling maps input 24 to just one output count. */
    if (sending && !error) LED(1, 0, 0, 192);
    if (!sending && !error) LED(2, 144, 144, 0);
    LED(5, error ? 192 : 0, 0, 0);
    LED_SHOW(); self->pulse_ticks = 25;
}

static int transmit(App *self, const char *packet, usize size) {
    int error = RADIO_SEND(packet, size);
    if (!error) error = RADIO_RESUME();
    if (error) ++self->errors; else ++self->sent;
    PRINT("OC_NATIVE|tx=%s|result=%d\n", packet, error);
    signal(self, error != 0, 1);
    return error;
}

static void button(App *self, u32 event) {
    /* Stock stores a two-byte event then loads a whole register. Upper bits
     * are unspecified. Low byte button A=0, next byte press=0. */
    if ((event & 0xffff) != 0 || self->phase != 2 || self->wait_ticks) return;
    u32 current = self->sequence++;
    if (self->sequence > 99999999) self->sequence = 1;
    FORMAT(self->pending, sizeof(self->pending), "OC1|%08u|N|I:MEAT", current);
    self->advertise_ticks = 0;
    self->attempts = 1;
    self->wait_ticks = WAIT_TICKS;
    if (transmit(self, self->pending, EVENT_BYTES)) {
        self->wait_ticks = 0;
        RADIO_PAUSE();
        if (self->status) LABEL_TEXT(self->status, "Send error");
    } else if (self->status) LABEL_TEXT(self->status, "Event sent - waiting for ACK");
}

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
    self->active = self->inbox_full = self->dropped = 0;
    self->sent = self->received = self->errors = self->wait_ticks = 0;
    self->advertise_ticks = self->pulse_ticks = 0;
    self->attempts = self->sequence = 0;
    self->last[0] = 0;
    LED_CLEAR(); LED_SHOW();
    label(screen, "OVERCOOKED", 8);
    self->status = label(screen, "Starting radio...", 42);
    self->info = label(screen, "RX: none\nPeer: none", 83);
    label(screen, "A: send MEAT    HOME: Apps", 204);
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
            signal(self, 1, 0);
            heap("nvs_error");
            return;
        }
        /* Share's existing send path uses the same 30 ms advertising timing. */
        error = FN(0x42010dbe, int, u32, u32)(30, 30);
        if (!error) error = RADIO_START();
        heap("after_radio");
        PRINT("OC_NATIVE|radio_result=%d\n", error);
        if (self->status) LABEL_TEXT(self->status, error ? "Radio error\nSee serial log" : "Radio ready");
        if (error) { self->phase = 3; signal(self, 1, 0); }
        else {
            u8 mac[6];
            FN(0x42010fc2, void, u8 *)(mac);
            PRINT("OC_NATIVE|advertising_mac=%02x:%02x:%02x:%02x:%02x:%02x\n",
                  mac[5], mac[4], mac[3], mac[2], mac[1], mac[0]);
            self->sequence = FN(0x40389792, u32, void)() % 90000000u + 10000000u;
            /* Same trivial pointer-capture manager used by stock Lua radio,
             * but the invoker below never enters Lua or allocates memory. */
            const usize handler[4] = {(usize)self, 0, 0x4205e52a, (usize)receive};
            release(&self->active, 1);
            RADIO_HANDLER(handler);
            RADIO_PAUSE();
            LED(0, 0, 128, 0); LED_SHOW();
        }
    }
    if (self->phase == 2 && acquire(&self->inbox_full)) {
        char packet[22]; u8 peer[6];
        copy(packet, self->inbox, sizeof(packet)); copy(peer, self->peer, sizeof(peer));
        int rssi = self->rssi;
        release(&self->inbox_full, 0);
        int duplicate = equal(packet, self->last, 22) && equal(peer, self->last_peer, 6);
        int event = packet[13] == 'N';
        int ack = packet[13] == 'A';
        if (!duplicate) {
            copy(self->last, packet, 22); copy(self->last_peer, peer, 6);
            ++self->received;
            PRINT("OC_NATIVE|rx=%s|peer=%02x:%02x:%02x:%02x:%02x:%02x|rssi=%d\n",
                  packet, peer[5], peer[4], peer[3], peer[2], peer[1], peer[0], rssi);
            signal(self, 0, 0);
            if (event) PRINT("HTN26|RX|%02x:%02x:%02x:%02x:%02x:%02x|%d|%s\n",
                             peer[5], peer[4], peer[3], peer[2], peer[1], peer[0], rssi, packet);
            if (ack && self->wait_ticks && equal(packet + 4, self->pending + 4, 8)) {
                self->wait_ticks = self->advertise_ticks = 0; RADIO_PAUSE();
                if (self->status) LABEL_TEXT(self->status, "Event acknowledged");
                PRINT("OC_NATIVE|ack_matched=%.8s\n", packet + 4);
            }
            char text[112];
            FORMAT(text, sizeof(text), "RX: %.17s\nPeer: %02x:%02x:%02x:%02x:%02x:%02x\nTX %u  RX %u  ERR %u",
                   self->last + 4, peer[5], peer[4], peer[3], peer[2], peer[1], peer[0],
                   self->sent, self->received, self->errors);
            if (self->info) LABEL_TEXT(self->info, text);
        }
        /* ponytail: one outstanding sender at a time; add arbitration only when
         * simultaneous player traffic is exercised with a third badge. */
        if (event && !self->wait_ticks && (!duplicate || !self->advertise_ticks)) {
            char reply[18];
            FORMAT(reply, sizeof(reply), "OC1|%.8s|A|OK", packet + 4);
            int error = transmit(self, reply, ACK_BYTES);
            if (!error) self->advertise_ticks = ACK_TICKS;
            if (self->status) LABEL_TEXT(self->status, error ? "ACK send error" : "Event received / ACK sent");
        }
    }
    if (self->wait_ticks && --self->wait_ticks == 0) {
        RADIO_PAUSE();
        if (self->attempts < MAX_ATTEMPTS) {
            ++self->attempts;
            self->wait_ticks = WAIT_TICKS;
            if (transmit(self, self->pending, EVENT_BYTES)) {
                self->wait_ticks = 0;
                RADIO_PAUSE();
            }
            if (self->status) LABEL_TEXT(self->status, self->wait_ticks ? "Retrying event..." : "Retry send error");
        } else {
            ++self->errors; signal(self, 1, 0);
            if (self->status) LABEL_TEXT(self->status, "Event timeout / A retries");
            PRINT("OC_NATIVE|timeout=%.8s|attempts=%u\n", self->pending + 4, self->attempts);
        }
    }
    if (self->advertise_ticks && --self->advertise_ticks == 0) RADIO_PAUSE();
    if (self->pulse_ticks && --self->pulse_ticks == 0) {
        LED(1, 0, 0, 0); LED(2, 0, 0, 0); LED(5, 0, 0, 0); LED_SHOW();
    }
    if (++self->ticks == 250) {
        self->ticks = 0;
        heap("idle");
        PRINT("OC_NATIVE|counts|tx=%u|rx=%u|errors=%u|dropped=%u\n",
              self->sent, self->received, self->errors, self->dropped);
    }
}

static void leave(App *self) {
    release(&self->active, 0);
    RADIO_STOP();
    LED_CLEAR(); LED_SHOW();
    heap("exit");
    self->status = 0;
    self->phase = 0;
    self->ticks = 0;
    self->info = 0;
    self->inbox_full = self->wait_ticks = self->advertise_ticks = self->pulse_ticks = 0;
    self->attempts = 0;
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
    (usize)enter, (usize)leave, (usize)tick, (usize)button
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
    PRINT("OC_NATIVE|registered|build=controller1|object_bytes=%u\n", (u32)sizeof(App));
}
