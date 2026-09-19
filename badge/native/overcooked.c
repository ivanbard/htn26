/* Native extension for stock v0.1.2-392-gd3089c4 only. See README.md. */
typedef unsigned int u32;
typedef unsigned long usize;
typedef unsigned char u8;

enum Item { EMPTY, RAW_MEAT, CHOPPED_MEAT, COOKED_MEAT, BURNT_MEAT,
            BREAD, LETTUCE, CHOPPED_LETTUCE, CHEESE };
enum Plate { PLATE_BREAD = 1, PLATE_MEAT = 2, PLATE_LETTUCE = 4, PLATE_CHEESE = 8 };
enum Stove { STOVE_EMPTY, STOVE_COOKING, STOVE_COOKED, STOVE_WARNING, STOVE_BURNT };
enum Selection { SELECT_NONE, SELECT_LEFT, SELECT_RIGHT, SELECT_DOWN };
enum Role { ROLE_NONE, ROLE_PLAYER, ROLE_HOST };

typedef struct NfcCard {
    u8 uid[10], padding[2];
    u32 uid_size;
    u8 sak, padding2;
    unsigned short atqa;
} NfcCard;
_Static_assert(sizeof(NfcCard) == 20, "Recovered NFC card ABI changed");

typedef struct App {
    const usize *vtable;
    void *status;
    u32 phase, ticks;
    void *info;
    u32 active, inbox_full, inbox_size;
    char inbox[45];
    u8 peer[6], padding;
    int rssi;
    u32 dropped, sent, received, errors, wait_ticks, advertise_ticks, pulse_ticks;
    u32 attempts, sequence, pending_size, last_size;
    char pending[45], last[45];
    u8 last_peer[6];
    u8 held, plate, has_plate, selected, a_held, b_held, nfc_enabled;
    u8 role, game_active, player;
    u8 nfc_seen[10], nfc_seen_size, nfc_rearm;
    u32 nfc_poll_ticks, nfc_clear_ticks, shake_cooldown;
    u8 process_from, process_to;
    u8 stove_state[2], stove_view;
    u8 game_padding;
    u32 process_ticks, stove_ticks[2], stove_view_ticks;
    u32 game_ticks, shake_state_ticks, tap_cooldown;
} App;
_Static_assert(sizeof(App) == 300, "Update heap report when app size changes");

#define ACK_BYTES 17
#define WAIT_TICKS 150
#define ACK_TICKS 100
#define CUT_TICKS 150
#define STOVE_STEP_TICKS 125 /* ponytail: calibration knob; tune after badge play-test. */
#define STOVE_COOK_TICKS (STOVE_STEP_TICKS * 6)
#define STOVE_DONE_TICKS (STOVE_COOK_TICKS + 100)
#define STOVE_BURN_TICKS (STOVE_DONE_TICKS + 150)
#define GAME_TICKS 6000
#define MAX_ATTEMPTS 3
#define SHAKE_ABS_BITS 0x44c80000u /* 1600 mg; hardware calibration knob. */
#define TAP_ABS_BITS 0x44960000u /* 1200 mg; hardware calibration knob. */

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
#define NFC_ENABLE FN(0x4200ff2e, int, void)
#define NFC_STOP FN(0x42010016, void, void)
#define NFC_CARD FN(0x42010062, int, NfcCard *)
#define NFC_CLEAR FN(0x420100fc, void, void)
#define NFC_TEXT FN(0x42010138, int, char *, usize)
#define SENSOR_ACCEL FN(0x4200aed4, int, u32 *)
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

static usize length(const char *value) { usize n = 0; while (value[n]) ++n; return n; }
static void copy(void *target, const void *source, usize size) {
    u8 *a = target; const u8 *b = source;
    for (usize i = 0; i < size; ++i) a[i] = b[i];
}
static int equal(const void *left, const void *right, usize size) {
    const u8 *a = left, *b = right;
    for (usize i = 0; i < size; ++i) if (a[i] != b[i]) return 0;
    return 1;
}
static int same(const char *value, const char *expected) {
    usize a = length(value), b = length(expected);
    return a == b && equal(value, expected, a);
}
static int starts(const char *value, const char *prefix) {
    usize n = length(prefix);
    return length(value) >= n && equal(value, prefix, n);
}
static int sequence(const u8 *value) {
    for (int i = 0; i < 8; ++i) if (value[i] < '0' || value[i] > '9') return 0;
    return 1;
}
static u32 acquire(volatile u32 *word) {
    u32 value = *word; __asm__ volatile("fence r, rw" ::: "memory"); return value;
}
static void release(volatile u32 *word, u32 value) {
    __asm__ volatile("fence rw, w" ::: "memory"); *word = value;
}

static int valid_action(const u8 *value, usize size) {
    if (!size || size > 20) return 0;
    char action[21];
    copy(action, value, size); action[size] = 0;
    if (same(action, "CUT:START") || same(action, "CUT:DONE") || same(action, "CUT:FAIL") ||
        same(action, "GAME:START") || same(action, "GAME:END") ||
        same(action, "PLATE") || same(action, "DISCARD") ||
        same(action, "READY") || same(action, "PICK:MEAT") || same(action, "PICK:BREAD") ||
        same(action, "PICK:LETTUCE") || same(action, "PICK:CHEESE")) return 1;
    if (same(action, "STOVE1:PUT") || same(action, "STOVE1:TAKE") || same(action, "STOVE1:CHECK") ||
        same(action, "STOVE2:PUT") || same(action, "STOVE2:TAKE") || same(action, "STOVE2:CHECK")) return 1;
    if (size == 11 && starts(action, "SUBMIT:")) {
        for (int i = 7; i < 11; ++i)
            if (action[i] != '-' && action[i] != "BMLC"[i - 7]) return 0;
        return 1;
    }
    if (size == 11 && starts(action, "BUMP:P:")) {
        for (int i = 7; i < 11; ++i)
            if (action[i] != '-' && action[i] != "BMLC"[i - 7]) return 0;
        return 1;
    }
    if (size == 11 && starts(action, "BUMP:H:") && equal(action + 9, "--", 2)) {
        const char *items[] = {"--", "RM", "CM", "BM", "BR", "LT", "SL", "CH"};
        for (u32 i = 0; i < sizeof(items) / sizeof(items[0]); ++i)
            if (equal(action + 7, items[i], 2)) return 1;
    }
    return 0;
}

/* NimBLE task: copy only; the app task owns UI, gameplay, and transmission. */
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
    copy(self->inbox, p, *size); self->inbox_size = *size;
    copy(self->peer, *peer, 6); self->rssi = *rssi;
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
    signal(self, error != 0, 1); return error;
}

static const char *item_name(u8 item) {
    if (item == RAW_MEAT) return "RAW MEAT";
    if (item == CHOPPED_MEAT) return "CUT MEAT";
    if (item == COOKED_MEAT) return "COOKED MEAT";
    if (item == BURNT_MEAT) return "BURNT MEAT";
    if (item == BREAD) return "BREAD";
    if (item == LETTUCE) return "LETTUCE";
    if (item == CHOPPED_LETTUCE) return "SLICED LETTUCE";
    if (item == CHEESE) return "CHEESE";
    return "EMPTY";
}
static const char *selection_name(u8 selected) {
    if (selected == SELECT_LEFT) return "LEFT";
    if (selected == SELECT_RIGHT) return "RIGHT";
    if (selected == SELECT_DOWN) return "DOWN";
    return "NONE";
}
static const char *stove_name(u8 state) {
    if (state == STOVE_COOKING) return "COOK";
    if (state == STOVE_COOKED) return "DONE";
    if (state == STOVE_WARNING) return "WARN";
    if (state == STOVE_BURNT) return "BURNT";
    return "EMPTY";
}
static int platable(u8 item) {
    return item == COOKED_MEAT || item == BREAD || item == CHOPPED_LETTUCE || item == CHEESE;
}

static u8 plate_bit(u8 item) {
    if (item == BREAD) return PLATE_BREAD;
    if (item == COOKED_MEAT) return PLATE_MEAT;
    if (item == CHOPPED_LETTUCE) return PLATE_LETTUCE;
    if (item == CHEESE) return PLATE_CHEESE;
    return 0;
}

static void unknown_combo(App *self) {
    if (self->status) LABEL_TEXT(self->status, "UNKNOWN BUTTON COMBO");
    LED_CLEAR();
    for (u32 i = 0; i < 6; ++i) LED(i, 220, 0, 0);
    LED_SHOW(); self->pulse_ticks = 50;
}

static void render_game(App *self) {
    if (!self->info) return;
    char text[190];
    if (self->role == ROLE_NONE) {
        LABEL_TEXT(self->info, "A: PLAYER\nSTART: HOST"); return;
    }
    if (self->role == ROLE_HOST) {
        if (!self->game_active) LABEL_TEXT(self->info, "HOST\nPRESS START TO BEGIN");
        else {
            u32 seconds = (self->game_ticks + 49) / 50;
            FORMAT(text, sizeof(text), "HOST\nTIME: %u:%02u\nRECEIVED: %u",
                   seconds / 60, seconds % 60, self->received);
            LABEL_TEXT(self->info, text);
        }
        return;
    }
    if (!self->game_active) {
        FORMAT(text, sizeof(text), "PLAYER %u\nWAITING FOR GAME START", (u32)self->player);
        LABEL_TEXT(self->info, text); return;
    }
    FORMAT(text, sizeof(text),
           "PLAYER %u  HELD: %s\nPLATE: %s B%c M%c L%c C%c\nSELECT: %s\nSTOVES: L %s  R %s",
           (u32)self->player, item_name(self->held), self->has_plate ? "YES" : "NO",
           self->plate & PLATE_BREAD ? '+' : '-',
           self->plate & PLATE_MEAT ? '+' : '-', self->plate & PLATE_LETTUCE ? '+' : '-',
           self->plate & PLATE_CHEESE ? '+' : '-', selection_name(self->selected),
           stove_name(self->stove_state[0]), stove_name(self->stove_state[1]));
    LABEL_TEXT(self->info, text);
}

static void set_stove(App *self, int stove, u8 state) {
    self->stove_state[stove] = state;
    self->stove_ticks[stove] = 0;
}
static int action_stove(const char *action) { return starts(action, "STOVE2:") ? 1 : 0; }

static void reset_round(App *self) {
    self->held = self->plate = self->has_plate = self->selected = 0;
    self->a_held = self->b_held = self->process_from = self->process_to = 0;
    self->process_ticks = self->stove_view = self->stove_view_ticks = 0;
    set_stove(self, 0, STOVE_EMPTY); set_stove(self, 1, STOVE_EMPTY);
    LED_CLEAR(); LED_SHOW();
}

static void take_item(App *self, u8 item) {
    u8 bit = plate_bit(item);
    if (self->has_plate && bit) self->plate |= bit;
    else self->held = item;
}

static u8 code_item(const char *code) {
    if (equal(code, "RM", 2)) return RAW_MEAT;
    if (equal(code, "CM", 2)) return CHOPPED_MEAT;
    if (equal(code, "BM", 2)) return BURNT_MEAT;
    if (equal(code, "BR", 2)) return BREAD;
    if (equal(code, "LT", 2)) return LETTUCE;
    if (equal(code, "SL", 2)) return CHOPPED_LETTUCE;
    if (equal(code, "CH", 2)) return CHEESE;
    return EMPTY;
}

static void apply_bump(App *self, const char *state) {
    int peer_plate = state[0] == 'P';
    u8 remote_plate = 0, remote_item = EMPTY;
    if (peer_plate) {
        if (state[2] == 'B') remote_plate |= PLATE_BREAD;
        if (state[3] == 'M') remote_plate |= PLATE_MEAT;
        if (state[4] == 'L') remote_plate |= PLATE_LETTUCE;
        if (state[5] == 'C') remote_plate |= PLATE_CHEESE;
    } else remote_item = code_item(state + 2);
    if (self->has_plate != peer_plate) {
        if (self->has_plate && platable(remote_item) && !(self->plate & plate_bit(remote_item)))
            self->plate |= plate_bit(remote_item);
        else if (peer_plate && platable(self->held) && !(remote_plate & plate_bit(self->held)))
            self->held = EMPTY;
        else {
            self->held = peer_plate ? EMPTY : remote_item;
            self->plate = peer_plate ? remote_plate : 0;
            self->has_plate = peer_plate;
        }
    } else if (peer_plate) self->plate = remote_plate;
    else self->held = remote_item;
}

static void apply_action(App *self, const char *action, int local) {
    if (same(action, "GAME:START") && (!local || !self->game_active)) {
        reset_round(self); self->game_active = 1;
        if (self->role == ROLE_HOST) self->game_ticks = GAME_TICKS;
        if (self->status) LABEL_TEXT(self->status, "GAME STARTED");
    } else if (same(action, "GAME:END") && (!local || self->game_active)) {
        reset_round(self); self->game_active = 0; self->game_ticks = 0;
        if (self->status) LABEL_TEXT(self->status, "GAME OVER");
    } else if (same(action, "PICK:MEAT") && local) take_item(self, RAW_MEAT);
    else if (same(action, "PICK:BREAD") && local) take_item(self, BREAD);
    else if (same(action, "PICK:LETTUCE") && local) take_item(self, LETTUCE);
    else if (same(action, "PICK:CHEESE") && local) take_item(self, CHEESE);
    else if (same(action, "CUT:START") && local) {
        self->process_from = self->held;
        self->process_to = self->held == RAW_MEAT ? CHOPPED_MEAT : CHOPPED_LETTUCE;
        self->held = EMPTY; self->process_ticks = CUT_TICKS;
        if (self->status) LABEL_TEXT(self->status, "CUTTING - KEEP HOLDING A");
    } else if (same(action, "PLATE") && local) {
        self->has_plate = 1;
        self->plate |= plate_bit(self->held);
        self->held = EMPTY;
    } else if (starts(action, "STOVE1:") || starts(action, "STOVE2:")) {
        int stove = action_stove(action);
        if (starts(action + 7, "PUT")) {
            set_stove(self, stove, STOVE_COOKING);
            if (local) self->held = EMPTY;
        } else if (starts(action + 7, "TAKE")) {
            if (local) take_item(self, self->stove_state[stove] == STOVE_BURNT ? BURNT_MEAT : COOKED_MEAT);
            set_stove(self, stove, STOVE_EMPTY);
        }
        self->stove_view = (u8)(stove + 1); self->stove_view_ticks = 100;
    } else if (same(action, "DISCARD") && local) {
        self->held = EMPTY;
        if (self->status) LABEL_TEXT(self->status, "ITEM DROPPED");
    } else if (starts(action, "SUBMIT:") && local) {
        self->plate = self->has_plate = 0;
        if (self->status) LABEL_TEXT(self->status, "PLATE SUBMITTED TO PI");
    } else if (starts(action, "BUMP:") && !local) apply_bump(self, action + 5);
    render_game(self);
}

static void start_action(App *self, const char *action) {
    if (self->wait_ticks || self->process_ticks) return;
    u32 current = self->sequence++;
    if (self->sequence > 99999999) self->sequence = 1;
    int written = FORMAT(self->pending, sizeof(self->pending), "OC1|%08u|N|%s", current, action);
    if (written < 16 || written >= (int)sizeof(self->pending)) return;
    self->pending_size = (u32)written; self->advertise_ticks = 0;
    self->attempts = 1; self->wait_ticks = WAIT_TICKS;
    if (transmit(self, self->pending, self->pending_size)) {
        self->wait_ticks = 0; RADIO_PAUSE();
        if (self->status) LABEL_TEXT(self->status, "RADIO SEND ERROR");
    } else if (self->status) LABEL_TEXT(self->status, "ACTION SENT - WAITING ACK");
}

static void broadcast_action(App *self, const char *action) {
    u32 current = self->sequence++;
    int written = FORMAT(self->pending, sizeof(self->pending), "OC1|%08u|N|%s", current, action);
    if (written < 16 || written >= (int)sizeof(self->pending)) return;
    self->pending_size = (u32)written; self->wait_ticks = 0;
    if (!transmit(self, self->pending, self->pending_size)) self->advertise_ticks = WAIT_TICKS;
}

static void station_scan(App *self, const char *station) {
    if (!self->game_active || self->role != ROLE_PLAYER || self->wait_ticks || self->process_ticks) return;
    const char *action = 0;
    if (same(station, "pantry")) {
        if (self->selected == SELECT_RIGHT &&
            ((!self->has_plate && self->held == EMPTY) ||
             (self->has_plate && !(self->plate & PLATE_BREAD)))) action = "PICK:BREAD";
        else if (self->selected == SELECT_LEFT && !self->has_plate && self->held == EMPTY)
            action = "PICK:LETTUCE";
        else if (self->selected == SELECT_DOWN && !self->has_plate &&
                 (self->held == EMPTY || platable(self->held))) action = "PLATE";
    } else if (same(station, "fridge")) {
        if (self->selected == SELECT_RIGHT &&
            ((!self->has_plate && self->held == EMPTY) ||
             (self->has_plate && !(self->plate & PLATE_CHEESE)))) action = "PICK:CHEESE";
        else if (self->selected == SELECT_LEFT && !self->has_plate && self->held == EMPTY)
            action = "PICK:MEAT";
    } else if (same(station, "cutting board")) {
        if (self->a_held && !self->has_plate &&
            (self->held == RAW_MEAT || self->held == LETTUCE)) action = "CUT:START";
    } else if (same(station, "stove") &&
               (self->selected == SELECT_LEFT || self->selected == SELECT_RIGHT)) {
        int stove = self->selected == SELECT_RIGHT;
        char stove_action[14];
        const char *verb = "CHECK";
        if (self->held == CHOPPED_MEAT && self->stove_state[stove] == STOVE_EMPTY) verb = "PUT";
        else if (self->stove_state[stove] == STOVE_COOKED || self->stove_state[stove] == STOVE_WARNING) {
            if ((!self->has_plate && self->held == EMPTY) ||
                (self->has_plate && !(self->plate & PLATE_MEAT))) verb = "TAKE";
        } else if (self->stove_state[stove] == STOVE_BURNT &&
                   !self->has_plate && self->held == EMPTY) verb = "TAKE";
        FORMAT(stove_action, sizeof(stove_action), "STOVE%u:%s", (u32)stove + 1, verb);
        action = stove_action;
        start_action(self, action); return;
    }
    if (action) start_action(self, action);
    else unknown_combo(self);
}

static int same_uid(const NfcCard *card, App *self) {
    return card->uid_size == self->nfc_seen_size && card->uid_size <= 10 &&
           equal(card->uid, self->nfc_seen, card->uid_size);
}
static void poll_nfc(App *self) {
    if (!self->nfc_enabled || ++self->nfc_poll_ticks < 10) return;
    self->nfc_poll_ticks = 0;
    NfcCard card = {{0}, {0}, 0, 0, 0, 0};
    int present = NFC_CARD(&card);
    if (self->nfc_clear_ticks && --self->nfc_clear_ticks == 0 && (!present || same_uid(&card, self))) {
        NFC_CLEAR(); self->nfc_rearm = 1; return;
    }
    if (!present) {
        if (self->nfc_rearm) { self->nfc_rearm = 0; self->nfc_seen_size = 0; }
        return;
    }
    if (!card.uid_size || card.uid_size > 10) return;
    if (self->nfc_rearm && same_uid(&card, self)) return;
    if (self->nfc_rearm) { self->nfc_rearm = 0; self->nfc_seen_size = 0; }
    if (same_uid(&card, self)) return;
    copy(self->nfc_seen, card.uid, card.uid_size); self->nfc_seen_size = (u8)card.uid_size;
    self->nfc_clear_ticks = 5;
    char text[32];
    if (NFC_TEXT(text, sizeof(text))) {
        if (self->status) LABEL_TEXT(self->status, "NFC TEXT READ FAILED");
        return;
    }
    text[sizeof(text) - 1] = 0;
    PRINT("OC_NATIVE|nfc=%s\n", text);
    station_scan(self, text);
}

static u32 motion(void) {
    u32 xyz[3];
    if (SENSOR_ACCEL(xyz)) return 0;
    u32 value = xyz[0] & 0x7fffffffu;
    for (int i = 1; i < 3; ++i) if ((xyz[i] & 0x7fffffffu) > value) value = xyz[i] & 0x7fffffffu;
    return value;
}
static const char *item_code(u8 item) {
    if (item == RAW_MEAT) return "RM";
    if (item == CHOPPED_MEAT) return "CM";
    if (item == BURNT_MEAT) return "BM";
    if (item == BREAD) return "BR";
    if (item == LETTUCE) return "LT";
    if (item == CHOPPED_LETTUCE) return "SL";
    if (item == CHEESE) return "CH";
    return "--";
}
static void poll_motion(App *self) {
    if (!self->game_active || self->role != ROLE_PLAYER) return;
    if (self->shake_state_ticks) --self->shake_state_ticks;
    if (self->tap_cooldown) --self->tap_cooldown;
    if (self->shake_cooldown) { --self->shake_cooldown; return; }
    u32 value = motion();
    if (value > SHAKE_ABS_BITS) {
        self->shake_cooldown = 25; self->shake_state_ticks = 25;
        if (self->b_held && self->held != EMPTY) start_action(self, "DISCARD");
        else if (self->a_held && self->has_plate) {
        char action[12];
        FORMAT(action, sizeof(action), "SUBMIT:%c%c%c%c",
               self->plate & PLATE_BREAD ? 'B' : '-', self->plate & PLATE_MEAT ? 'M' : '-',
               self->plate & PLATE_LETTUCE ? 'L' : '-', self->plate & PLATE_CHEESE ? 'C' : '-');
        start_action(self, action);
        } else start_action(self, "READY");
    } else if (!self->tap_cooldown && value > TAP_ABS_BITS) {
        char action[12];
        if (self->has_plate)
            FORMAT(action, sizeof(action), "BUMP:P:%c%c%c%c",
                   self->plate & PLATE_BREAD ? 'B' : '-', self->plate & PLATE_MEAT ? 'M' : '-',
                   self->plate & PLATE_LETTUCE ? 'L' : '-', self->plate & PLATE_CHEESE ? 'C' : '-');
        else FORMAT(action, sizeof(action), "BUMP:H:%s--", item_code(self->held));
        self->tap_cooldown = 25; start_action(self, action);
    }
}

static void render_progress(App *self) {
    if (self->pulse_ticks) return;
    LED_CLEAR();
    if (self->process_ticks) {
        u32 done = CUT_TICKS - self->process_ticks;
        u32 count = done * 6 / CUT_TICKS + 1;
        for (u32 i = 0; i < count && i < 6; ++i) LED(i, 0, 170, 50);
    } else if (self->stove_view) {
        int stove = self->stove_view - 1;
        u8 state = self->stove_state[stove];
        if (state == STOVE_BURNT) for (u32 i = 0; i < 6; ++i) LED(i, 210, 0, 0);
        else if (state == STOVE_WARNING) {
            if ((self->ticks / 10) & 1) for (u32 i = 0; i < 6; ++i) LED(i, 210, 0, 0);
        } else if (state == STOVE_COOKED) {
            for (u32 i = 0; i < 6; ++i) LED(i, 0, 190, 40);
        } else if (state == STOVE_COOKING) {
            u32 count = self->stove_ticks[stove] / STOVE_STEP_TICKS + 1;
            for (u32 i = 0; i < count && i < 6; ++i) LED(i, 180, 120, 0);
        }
    }
    LED_SHOW();
}

static void button(App *self, u32 event) {
    if (self->phase != 2) return;
    u8 key = event & 0xff, kind = (event >> 8) & 0xff;
    if (self->role == ROLE_NONE && kind == 0) {
        if (key == 0) self->role = ROLE_PLAYER;
        else if (key == 8) self->role = ROLE_HOST;
        else { unknown_combo(self); return; }
        if (self->status) LABEL_TEXT(self->status,
            self->role == ROLE_HOST ? "HOST READY - PRESS START" : "PLAYER READY - WAIT FOR START");
        render_game(self); return;
    }
    if (self->role == ROLE_HOST && kind == 0 && key == 8 && !self->game_active && !self->wait_ticks) {
        PRINT("HTN26|GAME|START|120\n");
        apply_action(self, "GAME:START", 1); broadcast_action(self, "GAME:START"); return;
    }
    if (key == 0) self->a_held = kind == 0;
    if (key == 1) self->b_held = kind == 0;
    if (kind == 1 && key == 0 && self->process_ticks) {
        self->held = self->process_from; self->process_ticks = 0; self->process_to = EMPTY;
        if (self->status) LABEL_TEXT(self->status, "CUT RESET - A RELEASED");
        render_game(self); LED_CLEAR(); LED_SHOW(); start_action(self, "CUT:FAIL");
    }
    if (kind != 0 || !self->game_active || self->role != ROLE_PLAYER ||
        self->wait_ticks || self->process_ticks) return;
    if (key == 3) self->selected = SELECT_DOWN;
    if (key == 4) self->selected = SELECT_LEFT;
    if (key == 5) self->selected = SELECT_RIGHT;
    if (key >= 3 && key <= 5) {
        if (self->status) LABEL_TEXT(self->status, "SELECTION SET - SCAN TAG");
        render_game(self);
    }
}

static void *label(void *screen, const char *text, int y) {
    void *object = FN(0x420ce062, void *, void *)(screen);
    if (!object) return 0;
    LABEL_TEXT(object, text);
    FN(0x420a908c, void, void *, int, int)(object, 12, y);
    FN(0x420a90b2, void, void *, int)(object, 290);
    FN(0x420ae15c, void, void *, const void *, u32)(object, (void *)0x3c24bffc, 0);
    u32 color = FN(0x420bd958, u32, u32)(0xf4f4ef);
    FN(0x420ae11a, void, void *, u32, u32)(object, color, 0); return object;
}

static void enter(App *self, void *screen) {
    heap("entry"); self->ticks = 0; self->phase = 1;
    u32 color = FN(0x420bd958, u32, u32)(0x050505);
    FN(0x420addea, void, void *, u32, u32)(screen, color, 0);
    FN(0x420ade14, void, void *, u32, u32)(screen, 255, 0);
    self->active = self->inbox_full = self->inbox_size = self->dropped = 0;
    self->sent = self->received = self->errors = self->wait_ticks = 0;
    self->advertise_ticks = self->pulse_ticks = self->attempts = self->sequence = 0;
    self->pending_size = self->last_size = 0; self->last[0] = 0;
    self->held = self->plate = self->has_plate = self->selected = self->a_held = self->b_held = 0;
    self->role = self->game_active = self->player = 0;
    self->nfc_enabled = self->nfc_seen_size = self->nfc_rearm = 0;
    self->nfc_poll_ticks = self->nfc_clear_ticks = self->shake_cooldown = 0;
    self->process_from = self->process_to = self->stove_view = 0;
    self->stove_state[0] = self->stove_state[1] = 0;
    self->process_ticks = self->stove_ticks[0] = self->stove_ticks[1] = self->stove_view_ticks = 0;
    self->game_ticks = self->shake_state_ticks = self->tap_cooldown = 0;
    LED_CLEAR(); LED_SHOW();
    label(screen, "OVERCOOKED CONTROLLER", 7);
    self->status = label(screen, "Starting radio + NFC...", 34);
    self->info = label(screen, "HELD: EMPTY", 68);
    label(screen, "A player   START host   HOME exit", 214);
    render_game(self);
}

static void start_hardware(App *self) {
    self->phase = 2; heap("before_radio");
    int error = FN(0x42101718, int, void)();
    if (error) {
        PRINT("OC_NATIVE|nvs_preflight_failed=%d|radio_not_started\n", error);
        if (self->status) LABEL_TEXT(self->status, "NVS ERROR / RADIO NOT STARTED");
        self->phase = 3; signal(self, 1, 0); heap("nvs_error"); return;
    }
    error = FN(0x42010dbe, int, u32, u32)(30, 30);
    if (!error) error = RADIO_START();
    heap("after_radio"); PRINT("OC_NATIVE|radio_result=%d\n", error);
    if (error) {
        if (self->status) LABEL_TEXT(self->status, "RADIO ERROR / SEE SERIAL");
        self->phase = 3; signal(self, 1, 0); return;
    }
    u8 mac[6]; FN(0x42010fc2, void, u8 *)(mac);
    PRINT("OC_NATIVE|advertising_mac=%02x:%02x:%02x:%02x:%02x:%02x\n",
          mac[5], mac[4], mac[3], mac[2], mac[1], mac[0]);
    self->player = mac[0] % 99 + 1; /* ponytail: host assignment only if a collision is observed. */
    self->sequence = FN(0x40389792, u32, void)() % 90000000u + 10000000u;
    const usize handler[4] = {(usize)self, 0, 0x4205e52a, (usize)receive};
    release(&self->active, 1); RADIO_HANDLER(handler); RADIO_PAUSE();
    self->nfc_enabled = NFC_ENABLE() == 0;
    if (self->nfc_enabled) NFC_CLEAR();
    if (self->status) LABEL_TEXT(self->status,
        self->nfc_enabled ? "CHOOSE ROLE: A PLAYER / START HOST" : "RADIO READY / NFC ERROR");
    LED(0, 0, 128, 0); LED_SHOW();
}

static void consume_radio(App *self) {
    char packet[45]; u8 peer[6]; u32 size = self->inbox_size;
    copy(packet, self->inbox, sizeof(packet)); copy(peer, self->peer, sizeof(peer));
    int rssi = self->rssi; release(&self->inbox_full, 0);
    int duplicate = size == self->last_size && equal(packet, self->last, size) && equal(peer, self->last_peer, 6);
    int event = packet[13] == 'N', ack = packet[13] == 'A';
    int control = event && (same(packet + 15, "GAME:START") || same(packet + 15, "GAME:END"));
    if (event && !control && !self->game_active) event = 0;
    if (!duplicate) {
        for (usize i = 0; i < sizeof(self->last); ++i) self->last[i] = 0;
        copy(self->last, packet, size); self->last_size = size; copy(self->last_peer, peer, 6);
        ++self->received;
        PRINT("OC_NATIVE|rx=%s|peer=%02x:%02x:%02x:%02x:%02x:%02x|rssi=%d\n",
              packet, peer[5], peer[4], peer[3], peer[2], peer[1], peer[0], rssi);
        signal(self, 0, 0);
        if (event) {
            PRINT("HTN26|RX|%02x:%02x:%02x:%02x:%02x:%02x|%d|%s\n",
                  peer[5], peer[4], peer[3], peer[2], peer[1], peer[0], rssi, packet);
            apply_action(self, packet + 15, 0);
        }
        if (ack && self->wait_ticks && equal(packet + 4, self->pending + 4, 8)) {
            self->wait_ticks = self->advertise_ticks = 0; RADIO_PAUSE();
            if (self->status) LABEL_TEXT(self->status, "ACTION ACKNOWLEDGED");
            apply_action(self, self->pending + 15, 1);
            PRINT("OC_NATIVE|ack_matched=%.8s\n", packet + 4);
        }
    }
    /* ponytail: one outstanding sender; add radio arbitration after 3+ badge tests. */
    if (event && (!self->wait_ticks || starts(packet + 15, "BUMP:")) &&
        (!duplicate || !self->advertise_ticks)) {
        char reply[18]; FORMAT(reply, sizeof(reply), "OC1|%.8s|A|OK", packet + 4);
        int error = transmit(self, reply, ACK_BYTES);
        if (!error) self->advertise_ticks = ACK_TICKS;
    }
}

static void tick(App *self) {
    if (self->phase == 1) start_hardware(self);
    if (self->phase != 2) return;
    if (acquire(&self->inbox_full)) consume_radio(self);
    poll_nfc(self); poll_motion(self);

    if (self->process_ticks) {
        if (--self->process_ticks == 0) {
            self->held = self->process_to; self->process_from = self->process_to = EMPTY;
            if (self->status) LABEL_TEXT(self->status, "CUT COMPLETE");
            render_game(self); LED_CLEAR(); LED_SHOW(); start_action(self, "CUT:DONE");
        } else render_progress(self);
    }
    for (int i = 0; i < 2; ++i) if (self->stove_state[i] == STOVE_COOKING ||
                                         self->stove_state[i] == STOVE_COOKED ||
                                         self->stove_state[i] == STOVE_WARNING) {
        ++self->stove_ticks[i];
        if (self->stove_state[i] == STOVE_COOKING && self->stove_ticks[i] >= STOVE_COOK_TICKS) {
            self->stove_state[i] = STOVE_COOKED; self->stove_view = i + 1; self->stove_view_ticks = 100;
            render_game(self);
        }
        if (self->stove_state[i] == STOVE_COOKED && self->stove_ticks[i] >= STOVE_DONE_TICKS) {
            self->stove_state[i] = STOVE_WARNING; self->stove_view = i + 1; self->stove_view_ticks = 150;
            render_game(self);
        }
        if (self->stove_ticks[i] >= STOVE_BURN_TICKS) {
            self->stove_state[i] = STOVE_BURNT; self->stove_view = i + 1; self->stove_view_ticks = 150;
            render_game(self);
        }
    }
    if (self->stove_view_ticks) {
        --self->stove_view_ticks; render_progress(self);
        if (!self->stove_view_ticks) { self->stove_view = 0; LED_CLEAR(); LED_SHOW(); render_game(self); }
    }
    if (self->wait_ticks && --self->wait_ticks == 0) {
        RADIO_PAUSE();
        if (self->attempts < MAX_ATTEMPTS) {
            ++self->attempts; self->wait_ticks = WAIT_TICKS;
            if (transmit(self, self->pending, self->pending_size)) { self->wait_ticks = 0; RADIO_PAUSE(); }
            if (self->status) LABEL_TEXT(self->status, self->wait_ticks ? "RETRYING ACTION" : "RETRY SEND ERROR");
        } else {
            ++self->errors; signal(self, 1, 0);
            if (self->status) LABEL_TEXT(self->status, "ACTION TIMEOUT / SCAN AGAIN");
        }
    }
    if (self->advertise_ticks && --self->advertise_ticks == 0) RADIO_PAUSE();
    if (self->pulse_ticks && --self->pulse_ticks == 0 && !self->process_ticks && !self->stove_view_ticks) {
        LED_CLEAR(); LED_SHOW();
    }
    if (self->role == ROLE_HOST && self->game_active && self->game_ticks) {
        --self->game_ticks;
        if (!self->game_ticks) {
            PRINT("HTN26|GAME|END\n");
            apply_action(self, "GAME:END", 1); broadcast_action(self, "GAME:END");
        } else if (!(self->game_ticks % 50)) render_game(self);
    }
    if (++self->ticks == 250) {
        self->ticks = 0; heap("idle");
        PRINT("OC_NATIVE|counts|tx=%u|rx=%u|errors=%u|dropped=%u\n",
              self->sent, self->received, self->errors, self->dropped);
    }
}

static void leave(App *self) {
    release(&self->active, 0);
    if (self->nfc_enabled) NFC_STOP();
    RADIO_STOP(); LED_CLEAR(); LED_SHOW(); heap("exit");
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
    app->vtable = vtable; FN(0x4203aace, void, void *)(app);
    PRINT("OC_NATIVE|registered|build=update1.1|object_bytes=%u\n", (u32)sizeof(App));
}
