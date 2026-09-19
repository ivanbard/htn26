/* Native extension for v0.1.2-392-gd3089c4 only. See README.md. */
typedef unsigned int u32;
typedef unsigned long usize;
typedef unsigned char u8;

enum Item { EMPTY, RAW_MEAT, CHOPPED_MEAT, COOKED_MEAT, BREAD, LETTUCE, CHOPPED_LETTUCE, CHEESE };
enum Plate { PLATE_BREAD = 1, PLATE_MEAT = 2, PLATE_LETTUCE = 4, PLATE_CHEESE = 8 };

typedef struct App {
    const usize *vtable;
    void *status;
    u32 phase;
    u32 ticks;
    void *info;
    u32 active, inbox_full, inbox_size;
    char inbox[45];
    u8 peer[6];
    u8 padding;
    int rssi;
    u32 dropped, sent, received, errors, wait_ticks, advertise_ticks, pulse_ticks;
    u32 attempts, sequence, pending_size, last_size;
    char pending[45], last[45];
    u8 last_peer[6];
    u8 held, plate;
    u32 score, process_ticks;
    u8 process_to;
    u8 state_padding[3];
} App;
_Static_assert(sizeof(App) == 244, "Update heap report when app size changes");

#define ACK_BYTES 17
#define WAIT_TICKS 150
#define ACK_TICKS 100
#define PROCESS_TICKS 150
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

static usize length(const char *value) {
    usize size = 0;
    while (value[size]) ++size;
    return size;
}

static int equal(const void *left, const void *right, usize size) {
    const u8 *a = left, *b = right;
    for (usize i = 0; i < size; ++i) if (a[i] != b[i]) return 0;
    return 1;
}

static int same_text(const u8 *value, usize size, const char *expected) {
    usize expected_size = length(expected);
    return size == expected_size && equal(value, expected, size);
}

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

static int valid_action(const u8 *value, usize size) {
    return same_text(value, size, "PICK:MEAT") || same_text(value, size, "PICK:BREAD") ||
           same_text(value, size, "PICK:LETTUCE") || same_text(value, size, "PICK:CHEESE") ||
           same_text(value, size, "CUT") || same_text(value, size, "STOVE") ||
           same_text(value, size, "PLATE") || same_text(value, size, "SERVE") ||
           same_text(value, size, "DISCARD");
}

/* NimBLE task: copy only. UI and transmission stay on the app task.
 * ponytail: one pending receive slot; add a bounded queue only after measured drops. */
static void receive(const usize *capture, const u8 **peer, const signed char *rssi,
                    const u8 **data, const usize *size) {
    App *self = (App *)capture[0];
    if (!acquire(&self->active) || *size < ACK_BYTES || *size >= sizeof(self->inbox)) return;
    const u8 *p = *data;
    int event = *size > 15 && equal(p, "OC1|", 4) && sequence(p + 4) &&
                equal(p + 12, "|N|", 3) && valid_action(p + 15, *size - 15);
    int ack = *size == ACK_BYTES && equal(p, "OC1|", 4) && sequence(p + 4) &&
              equal(p + 12, "|A|OK", 5);
    if (!event && !ack) return;
    if (acquire(&self->inbox_full)) { ++self->dropped; return; }
    for (usize i = 0; i < sizeof(self->inbox); ++i) self->inbox[i] = 0;
    copy(self->inbox, p, *size);
    self->inbox_size = *size;
    copy(self->peer, *peer, 6);
    self->rssi = *rssi;
    release(&self->inbox_full, 1);
}

static void signal(App *self, int error, int sending) {
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

static const char *item_name(u8 item) {
    if (item == RAW_MEAT) return "RAW MEAT";
    if (item == CHOPPED_MEAT) return "CHOPPED MEAT";
    if (item == COOKED_MEAT) return "COOKED MEAT";
    if (item == BREAD) return "BREAD";
    if (item == LETTUCE) return "LETTUCE";
    if (item == CHOPPED_LETTUCE) return "CHOPPED LETTUCE";
    if (item == CHEESE) return "CHEESE";
    return "EMPTY";
}

static const char *next_action(App *self) {
    if (self->process_ticks) return "WAIT";
    if (self->held == RAW_MEAT || self->held == LETTUCE) return "CUT";
    if (self->held == CHOPPED_MEAT) return "STOVE";
    if (self->held != EMPTY) return "PLATE";
    if (!(self->plate & PLATE_MEAT)) return "PICK:MEAT";
    if (!(self->plate & PLATE_BREAD)) return "PICK:BREAD";
    if (!(self->plate & PLATE_LETTUCE)) return "PICK:LETTUCE";
    if (!(self->plate & PLATE_CHEESE)) return "PICK:CHEESE";
    return "SERVE";
}

static void render_game(App *self) {
    if (!self->info) return;
    char text[180];
    FORMAT(text, sizeof(text),
           "ORDER: BURGER\nHELD: %s\nPLATE: B%c M%c L%c C%c\nSCORE: %u\nNEXT: %s",
           item_name(self->held), self->plate & PLATE_BREAD ? '+' : '-',
           self->plate & PLATE_MEAT ? '+' : '-', self->plate & PLATE_LETTUCE ? '+' : '-',
           self->plate & PLATE_CHEESE ? '+' : '-', self->score, next_action(self));
    LABEL_TEXT(self->info, text);
}

static void apply_action(App *self, const char *action) {
    if (same_text((const u8 *)action, length(action), "PICK:MEAT")) self->held = RAW_MEAT;
    else if (same_text((const u8 *)action, length(action), "PICK:BREAD")) self->held = BREAD;
    else if (same_text((const u8 *)action, length(action), "PICK:LETTUCE")) self->held = LETTUCE;
    else if (same_text((const u8 *)action, length(action), "PICK:CHEESE")) self->held = CHEESE;
    else if (same_text((const u8 *)action, length(action), "CUT")) {
        self->process_to = self->held == RAW_MEAT ? CHOPPED_MEAT : CHOPPED_LETTUCE;
        self->held = EMPTY; self->process_ticks = PROCESS_TICKS;
        if (self->status) LABEL_TEXT(self->status, "Processing: CUT (3 sec)");
    } else if (same_text((const u8 *)action, length(action), "STOVE")) {
        self->process_to = COOKED_MEAT; self->held = EMPTY; self->process_ticks = PROCESS_TICKS;
        if (self->status) LABEL_TEXT(self->status, "Processing: STOVE (3 sec)");
    } else if (same_text((const u8 *)action, length(action), "PLATE")) {
        if (self->held == BREAD) self->plate |= PLATE_BREAD;
        if (self->held == COOKED_MEAT) self->plate |= PLATE_MEAT;
        if (self->held == CHOPPED_LETTUCE) self->plate |= PLATE_LETTUCE;
        if (self->held == CHEESE) self->plate |= PLATE_CHEESE;
        self->held = EMPTY;
    } else if (same_text((const u8 *)action, length(action), "SERVE")) {
        self->plate = 0; self->score += 100;
        if (self->status) LABEL_TEXT(self->status, "ORDER COMPLETE +100");
    } else if (same_text((const u8 *)action, length(action), "DISCARD")) {
        self->held = EMPTY;
        if (self->status) LABEL_TEXT(self->status, "Item discarded");
    }
    render_game(self);
}

static void start_action(App *self, const char *action) {
    u32 current = self->sequence++;
    if (self->sequence > 99999999) self->sequence = 1;
    int written = FORMAT(self->pending, sizeof(self->pending), "OC1|%08u|N|%s", current, action);
    if (written < 16 || written >= (int)sizeof(self->pending)) return;
    self->pending_size = (u32)written;
    self->advertise_ticks = 0;
    self->attempts = 1;
    self->wait_ticks = WAIT_TICKS;
    if (transmit(self, self->pending, self->pending_size)) {
        self->wait_ticks = 0; RADIO_PAUSE();
        if (self->status) LABEL_TEXT(self->status, "Send error");
    } else if (self->status) LABEL_TEXT(self->status, "Action sent - waiting for ACK");
}

static void button(App *self, u32 event) {
    /* Low byte: A=0, B=1. Next byte: press=0. Upper bits are unspecified. */
    if ((event & 0xff00) || self->phase != 2 || self->wait_ticks || self->process_ticks) return;
    u8 key = event & 0xff;
    if (key == 0) start_action(self, next_action(self));
    /* Temporary play-test control until the private IMU callback is recovered. */
    if (key == 1 && self->held != EMPTY) start_action(self, "DISCARD");
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
    self->ticks = 0; self->phase = 1;
    u32 color = FN(0x420bd958, u32, u32)(0x050505);
    FN(0x420addea, void, void *, u32, u32)(screen, color, 0);
    FN(0x420ade14, void, void *, u32, u32)(screen, 255, 0);
    self->active = self->inbox_full = self->inbox_size = self->dropped = 0;
    self->sent = self->received = self->errors = self->wait_ticks = 0;
    self->advertise_ticks = self->pulse_ticks = self->attempts = self->sequence = 0;
    self->pending_size = self->last_size = 0;
    self->last[0] = 0;
    self->held = self->plate = self->process_to = 0;
    self->score = self->process_ticks = 0;
    LED_CLEAR(); LED_SHOW();
    label(screen, "OVERCOOKED", 8);
    self->status = label(screen, "Starting radio...", 35);
    self->info = label(screen, "ORDER: BURGER", 68);
    label(screen, "A: NEXT   B: DISCARD   HOME: Apps", 214);
    render_game(self);
}

static void tick(App *self) {
    if (self->phase == 1) {
        self->phase = 2;
        heap("before_radio");
        int error = FN(0x42101718, int, void)();
        if (error) {
            PRINT("OC_NATIVE|nvs_preflight_failed=%d|radio_not_started\n", error);
            if (self->status) LABEL_TEXT(self->status, "NVS error / radio not started");
            self->phase = 3; signal(self, 1, 0); heap("nvs_error"); return;
        }
        error = FN(0x42010dbe, int, u32, u32)(30, 30);
        if (!error) error = RADIO_START();
        heap("after_radio");
        PRINT("OC_NATIVE|radio_result=%d\n", error);
        if (self->status) LABEL_TEXT(self->status, error ? "Radio error / see serial" : "Radio ready - press A");
        if (error) { self->phase = 3; signal(self, 1, 0); }
        else {
            u8 mac[6];
            FN(0x42010fc2, void, u8 *)(mac);
            PRINT("OC_NATIVE|advertising_mac=%02x:%02x:%02x:%02x:%02x:%02x\n",
                  mac[5], mac[4], mac[3], mac[2], mac[1], mac[0]);
            self->sequence = FN(0x40389792, u32, void)() % 90000000u + 10000000u;
            const usize handler[4] = {(usize)self, 0, 0x4205e52a, (usize)receive};
            release(&self->active, 1); RADIO_HANDLER(handler); RADIO_PAUSE();
            LED(0, 0, 128, 0); LED_SHOW();
        }
    }

    if (self->phase == 2 && acquire(&self->inbox_full)) {
        char packet[45]; u8 peer[6]; u32 size = self->inbox_size;
        copy(packet, self->inbox, sizeof(packet)); copy(peer, self->peer, sizeof(peer));
        int rssi = self->rssi;
        release(&self->inbox_full, 0);
        int duplicate = size == self->last_size && equal(packet, self->last, size) && equal(peer, self->last_peer, 6);
        int event = packet[13] == 'N';
        int ack = packet[13] == 'A';
        if (!duplicate) {
            for (usize i = 0; i < sizeof(self->last); ++i) self->last[i] = 0;
            copy(self->last, packet, size); self->last_size = size; copy(self->last_peer, peer, 6);
            ++self->received;
            PRINT("OC_NATIVE|rx=%s|peer=%02x:%02x:%02x:%02x:%02x:%02x|rssi=%d\n",
                  packet, peer[5], peer[4], peer[3], peer[2], peer[1], peer[0], rssi);
            signal(self, 0, 0);
            if (event) PRINT("HTN26|RX|%02x:%02x:%02x:%02x:%02x:%02x|%d|%s\n",
                             peer[5], peer[4], peer[3], peer[2], peer[1], peer[0], rssi, packet);
            if (ack && self->wait_ticks && equal(packet + 4, self->pending + 4, 8)) {
                self->wait_ticks = self->advertise_ticks = 0; RADIO_PAUSE();
                if (self->status) LABEL_TEXT(self->status, "Action acknowledged");
                apply_action(self, self->pending + 15);
                PRINT("OC_NATIVE|ack_matched=%.8s\n", packet + 4);
            }
        }
        /* ponytail: one outstanding sender at a time; add arbitration with 3+ active badges. */
        if (event && !self->wait_ticks && (!duplicate || !self->advertise_ticks)) {
            char reply[18];
            FORMAT(reply, sizeof(reply), "OC1|%.8s|A|OK", packet + 4);
            int error = transmit(self, reply, ACK_BYTES);
            if (!error) self->advertise_ticks = ACK_TICKS;
            if (self->status) LABEL_TEXT(self->status, error ? "ACK send error" : "Peer action received / ACK sent");
        }
    }

    if (self->process_ticks && --self->process_ticks == 0) {
        self->held = self->process_to; self->process_to = EMPTY;
        if (self->status) LABEL_TEXT(self->status, "Processing complete");
        render_game(self); signal(self, 0, 0);
    }
    if (self->wait_ticks && --self->wait_ticks == 0) {
        RADIO_PAUSE();
        if (self->attempts < MAX_ATTEMPTS) {
            ++self->attempts; self->wait_ticks = WAIT_TICKS;
            if (transmit(self, self->pending, self->pending_size)) { self->wait_ticks = 0; RADIO_PAUSE(); }
            if (self->status) LABEL_TEXT(self->status, self->wait_ticks ? "Retrying action..." : "Retry send error");
        } else {
            ++self->errors; signal(self, 1, 0);
            if (self->status) LABEL_TEXT(self->status, "Action timeout / press A again");
            PRINT("OC_NATIVE|timeout=%.8s|attempts=%u\n", self->pending + 4, self->attempts);
        }
    }
    if (self->advertise_ticks && --self->advertise_ticks == 0) RADIO_PAUSE();
    if (self->pulse_ticks && --self->pulse_ticks == 0) {
        LED(1, 0, 0, 0); LED(2, 0, 0, 0); LED(5, 0, 0, 0); LED_SHOW();
    }
    if (++self->ticks == 250) {
        self->ticks = 0; heap("idle");
        PRINT("OC_NATIVE|counts|tx=%u|rx=%u|errors=%u|dropped=%u\n",
              self->sent, self->received, self->errors, self->dropped);
    }
}

static void leave(App *self) {
    release(&self->active, 0); RADIO_STOP(); LED_CLEAR(); LED_SHOW(); heap("exit");
    self->status = 0; self->phase = 0; self->ticks = 0; self->info = 0;
    self->inbox_full = self->wait_ticks = self->advertise_ticks = self->pulse_ticks = 0;
    self->process_ticks = self->attempts = 0;
}

static const usize vtable[25] = {
    (usize)zero, (usize)zero, (usize)name, (usize)short_name,
    (usize)identifier, 0x4203bd68,
    (usize)zero, (usize)zero, (usize)zero, (usize)zero,
    (usize)zero, (usize)yes,
    (usize)zero, (usize)zero, (usize)zero, (usize)period,
    (usize)zero, (usize)zero, (usize)zero, (usize)zero, (usize)zero,
    (usize)enter, (usize)leave, (usize)tick, (usize)button
};

__attribute__((section(".text.hook"), used))
void register_overcooked(void) {
    void *original = FN(0x420385a0, void *, void)();
    FN(0x4203aace, void, void *)(original);
    App *app = FN(0x40397474, void *, usize, usize)(1, sizeof(App));
    if (!app) { PRINT("OC_NATIVE|registration_failed=no_memory\n"); return; }
    app->vtable = vtable;
    FN(0x4203aace, void, void *)(app);
    PRINT("OC_NATIVE|registered|build=gameplay1|object_bytes=%u\n", (u32)sizeof(App));
}
