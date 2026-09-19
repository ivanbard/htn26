/* Native extension for stock v0.1.2-392-gd3089c4 only. See README.md. */
typedef unsigned int u32;
typedef unsigned long usize;
typedef unsigned char u8;

enum Item { EMPTY, RAW_MEAT, CHOPPED_MEAT, COOKED_MEAT, BURNT_MEAT,
            BREAD, LETTUCE, CHOPPED_LETTUCE, CHEESE, CHOPPED_CHEESE };
enum Plate { PLATE_BREAD = 1, PLATE_MEAT = 2, PLATE_LETTUCE = 4, PLATE_CHEESE = 8 };
enum Stove { STOVE_EMPTY, STOVE_COOKING, STOVE_COOKED, STOVE_WARNING, STOVE_BURNT };
enum Selection { SELECT_NONE, SELECT_LEFT, SELECT_RIGHT, SELECT_DOWN };
enum Role { ROLE_NONE, ROLE_PLAYER_SETUP, ROLE_PLAYER, ROLE_HOST };

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
    u8 peer[6], nfc_retries;
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
    u8 ready_ticks[3];
    u32 process_ticks, stove_ticks[2], stove_view_ticks;
    u32 game_ticks, control_sequence, tap_cooldown;
} App;
_Static_assert(sizeof(App) == 300, "Update heap report when app size changes");

#define ACK_BYTES 15
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
#define NFC_RX_TIMEOUT 0xf527
#define NFC_RX_TIMER_TIMEOUT 0xf528
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
    for (int i = 0; i < 6; ++i) if (value[i] < '0' || value[i] > '9') return 0;
    return 1;
}
static u32 sequence_value(const char *value) {
    u32 result = 0;
    for (int i = 0; i < 6; ++i) result = result * 10 + (u32)(value[i] - '0');
    return result;
}
static u32 acquire(volatile u32 *word) {
    u32 value = *word; __asm__ volatile("fence r, rw" ::: "memory"); return value;
}
static void release(volatile u32 *word, u32 value) {
    __asm__ volatile("fence rw, w" ::: "memory"); *word = value;
}

static int valid_plate(const char *value) {
    for (int i = 0; i < 4; ++i)
        if (value[i] != '-' && value[i] != "BMLC"[i]) return 0;
    return 1;
}
static int valid_snapshot(const char *value, usize size) {
    if (size == 5 && value[0] == 'P') return valid_plate(value + 1);
    if (size == 5 && equal(value, "E----", 5)) return 1;
    return size == 2 && value[0] == 'H' &&
           (value[1] == 'B' || value[1] == 'R' || value[1] == 'M' || value[1] == 'X' ||
            value[1] == 'Q' || value[1] == 'L' || value[1] == 'K' || value[1] == 'C');
}

/* Keep native application bytes compatible with badge/slave/main.lua. The
   native carrier omits Lua's private LUA1 wrapper, so profiles cannot mix. */
static int valid_action(const u8 *value, usize size) {
    if (!size || size > 20) return 0;
    char action[21];
    copy(action, value, size); action[size] = 0;
    if (same(action, "READY") || same(action, "CH:S") || same(action, "CH:F") ||
        same(action, "PL:NEW") || starts(action, "PU:")) {
        if (starts(action, "PU:"))
            return size == 4 && (action[3] == 'B' || action[3] == 'R' ||
                   action[3] == 'Q' || action[3] == 'K');
        return 1;
    }
    if (size == 7 && starts(action, "PL:")) return valid_plate(action + 3);
    if (size == 8 && starts(action, "SUB:")) return valid_plate(action + 4);
    if (size == 6 && starts(action, "CH:D:"))
        return action[5] == 'M' || action[5] == 'L' || action[5] == 'C';
    if (starts(action, "ST:") && size >= 6 && size <= 15 &&
        (action[3] == 'L' || action[3] == 'R') && action[4] == ':') {
        if (size == 6) return action[5] == 'P' || action[5] == 'T' || action[5] == 'X';
        return starts(action + 5, "C:");
    }
    if (starts(action, "DROP:")) return valid_snapshot(action + 5, size - 5);
    if (starts(action, "X:")) return valid_snapshot(action + 2, size - 2);
    return 0;
}

/* NimBLE task: copy only; the app task owns UI, gameplay, and transmission. */
static void receive(const usize *capture, const u8 **peer, const signed char *rssi,
                    const u8 **data, const usize *size) {
    App *self = (App *)capture[0];
    if (!acquire(&self->active) || *size < 14 || *size >= sizeof(self->inbox)) return;
    const u8 *p = *data;
    int event = *size > 16 && equal(p, "OC1|", 4) && sequence(p + 4) &&
                equal(p + 10, "|E|P", 4) && p[14] >= '1' && p[14] <= '3' && p[15] == ':' &&
                valid_action(p + 16, *size - 16);
    int control = *size == 14 && equal(p, "OC1|", 4) && sequence(p + 4) &&
                  equal(p + 10, "|G|", 3) && (p[13] == 'S' || p[13] == 'E');
    int ack = *size == ACK_BYTES && equal(p, "OC1|", 4) && sequence(p + 4) &&
              equal(p + 10, "|A|OK", 5);
    if (!event && !control && !ack) return;
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
    if (item == CHEESE) return "RAW CHEESE";
    if (item == CHOPPED_CHEESE) return "SLICED CHEESE";
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
    return item == COOKED_MEAT || item == BREAD || item == CHOPPED_LETTUCE ||
           item == CHOPPED_CHEESE;
}

static u8 plate_bit(u8 item) {
    if (item == BREAD) return PLATE_BREAD;
    if (item == COOKED_MEAT) return PLATE_MEAT;
    if (item == CHOPPED_LETTUCE) return PLATE_LETTUCE;
    if (item == CHOPPED_CHEESE) return PLATE_CHEESE;
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
    if (self->role == ROLE_PLAYER_SETUP) {
        FORMAT(text, sizeof(text), "CHOOSE PLAYER %u\nLEFT/RIGHT, A CONFIRM", (u32)self->player);
        LABEL_TEXT(self->info, text); return;
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

static void reset_round(App *self) {
    self->held = self->plate = self->has_plate = self->selected = 0;
    self->a_held = self->b_held = self->process_from = self->process_to = 0;
    self->process_ticks = self->stove_view = self->stove_view_ticks = 0;
    self->ready_ticks[0] = self->ready_ticks[1] = self->ready_ticks[2] = 0;
    set_stove(self, 0, STOVE_EMPTY); set_stove(self, 1, STOVE_EMPTY);
    LED_CLEAR(); LED_SHOW();
}

static void take_item(App *self, u8 item) {
    u8 bit = plate_bit(item);
    if (self->has_plate && bit) self->plate |= bit;
    else self->held = item;
}

static u8 short_item(char code) {
    if (code == 'R') return RAW_MEAT;
    if (code == 'M') return COOKED_MEAT;
    if (code == 'X') return BURNT_MEAT;
    if (code == 'B') return BREAD;
    if (code == 'Q') return LETTUCE;
    if (code == 'L') return CHOPPED_LETTUCE;
    if (code == 'K') return CHEESE;
    if (code == 'C') return CHOPPED_CHEESE;
    return EMPTY;
}

static char item_short(u8 item) {
    if (item == RAW_MEAT) return 'R';
    if (item == CHOPPED_MEAT || item == COOKED_MEAT) return 'M';
    if (item == BURNT_MEAT) return 'X';
    if (item == BREAD) return 'B';
    if (item == LETTUCE) return 'Q';
    if (item == CHOPPED_LETTUCE) return 'L';
    if (item == CHEESE) return 'K';
    if (item == CHOPPED_CHEESE) return 'C';
    return '-';
}

static void read_plate(u8 *plate, const char *summary) {
    *plate = 0;
    if (summary[0] == 'B') *plate |= PLATE_BREAD;
    if (summary[1] == 'M') *plate |= PLATE_MEAT;
    if (summary[2] == 'L') *plate |= PLATE_LETTUCE;
    if (summary[3] == 'C') *plate |= PLATE_CHEESE;
}

static void apply_bump(App *self, const char *state) {
    int peer_plate = state[0] == 'P';
    u8 remote_plate = 0, remote_item = EMPTY;
    if (peer_plate) read_plate(&remote_plate, state + 1);
    else if (state[0] == 'H') remote_item = short_item(state[1]);
    if (self->has_plate != peer_plate) {
        if ((self->has_plate && remote_item == EMPTY) ||
            (peer_plate && self->held == EMPTY)) return;
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

static void mark_ready(App *self, int player) {
    if (player >= 1 && player <= 3) self->ready_ticks[player - 1] = 25;
    if (self->ready_ticks[0] && self->ready_ticks[1] && self->ready_ticks[2]) {
        self->held = self->plate = self->has_plate = 0;
        self->process_from = self->process_to = 0; self->process_ticks = 0;
        if (self->status) LABEL_TEXT(self->status, "THREE READY - HELD STATE CLEARED");
    }
}

static void apply_action(App *self, const char *action, int local) {
    if (same(action, "GAME:START") && (!local || !self->game_active)) {
        reset_round(self); self->game_active = 1;
        if (self->role == ROLE_HOST) self->game_ticks = GAME_TICKS;
        if (self->status) LABEL_TEXT(self->status, "GAME STARTED");
    } else if (same(action, "GAME:END") && (!local || self->game_active)) {
        reset_round(self); self->game_active = 0; self->game_ticks = 0;
        if (self->status) LABEL_TEXT(self->status, "GAME OVER");
    } else if (starts(action, "PU:") && local) {
        take_item(self, short_item(action[3]));
    } else if (same(action, "CH:S") && local) {
        self->process_from = self->held;
        self->process_to = self->held == RAW_MEAT ? CHOPPED_MEAT :
                           self->held == CHEESE ? CHOPPED_CHEESE : CHOPPED_LETTUCE;
        self->held = EMPTY; self->process_ticks = CUT_TICKS;
        if (self->status) LABEL_TEXT(self->status, "CUTTING - KEEP HOLDING A");
    } else if (starts(action, "PL:") && local) {
        self->has_plate = 1;
        if (!same(action, "PL:NEW")) read_plate(&self->plate, action + 3);
        else self->plate = 0;
        self->held = EMPTY;
    } else if (starts(action, "ST:")) {
        int stove = action[3] == 'R';
        if (action[5] == 'P') {
            set_stove(self, stove, STOVE_COOKING);
            if (local) self->held = EMPTY;
        } else if (action[5] == 'T' || action[5] == 'X') {
            if (local) take_item(self, action[5] == 'X' ? BURNT_MEAT : COOKED_MEAT);
            set_stove(self, stove, STOVE_EMPTY);
        }
        self->stove_view = (u8)(stove + 1); self->stove_view_ticks = 100;
    } else if (starts(action, "DROP:") && local) {
        self->held = self->plate = self->has_plate = 0;
        if (self->status) LABEL_TEXT(self->status, "ITEM DROPPED");
    } else if (starts(action, "SUB:") && local) {
        self->plate = self->has_plate = 0;
        if (self->status) LABEL_TEXT(self->status, "PLATE SUBMITTED TO PI");
    } else if (starts(action, "X:") && !local) apply_bump(self, action + 2);
    render_game(self);
}

static void start_action(App *self, const char *action) {
    if (self->wait_ticks || self->process_ticks) return;
    u32 current = self->sequence++;
    if (self->sequence > 999999) self->sequence = 1;
    int written = FORMAT(self->pending, sizeof(self->pending),
                         "OC1|%06u|E|P%u:%s", current, (u32)self->player, action);
    if (written < 17 || written >= (int)sizeof(self->pending)) return;
    self->pending_size = (u32)written; self->advertise_ticks = 0;
    self->attempts = 1; self->wait_ticks = WAIT_TICKS;
    if (transmit(self, self->pending, self->pending_size)) {
        self->wait_ticks = 0; RADIO_PAUSE();
        if (self->status) LABEL_TEXT(self->status, "RADIO SEND ERROR");
    } else if (self->status) LABEL_TEXT(self->status, "ACTION SENT - WAITING ACK");
}

static void broadcast_control(App *self, char code) {
    u32 current = ++self->sequence;
    int written = FORMAT(self->pending, sizeof(self->pending), "OC1|%06u|G|%c", current, code);
    if (written != 14) return;
    self->pending_size = (u32)written; self->wait_ticks = 0;
    if (!transmit(self, self->pending, self->pending_size)) self->advertise_ticks = WAIT_TICKS;
}

static void plate_summary(char *target, u8 plate) {
    target[0] = plate & PLATE_BREAD ? 'B' : '-';
    target[1] = plate & PLATE_MEAT ? 'M' : '-';
    target[2] = plate & PLATE_LETTUCE ? 'L' : '-';
    target[3] = plate & PLATE_CHEESE ? 'C' : '-';
    target[4] = 0;
}

static const char *stove_phase(u8 state) {
    if (state == STOVE_COOKING) return "COOKING";
    if (state == STOVE_COOKED) return "DONE";
    if (state == STOVE_WARNING) return "WARNING";
    if (state == STOVE_BURNT) return "BURNT";
    return "EMPTY";
}

static void station_scan(App *self, const char *station) {
    if (!self->game_active || self->role != ROLE_PLAYER || self->wait_ticks || self->process_ticks) return;
    const char *action = 0;
    char dynamic[18];
    if (same(station, "pantry")) {
        if (self->selected == SELECT_RIGHT && self->has_plate && !(self->plate & PLATE_BREAD)) {
            char summary[5]; plate_summary(summary, self->plate | PLATE_BREAD);
            FORMAT(dynamic, sizeof(dynamic), "PL:%s", summary); action = dynamic;
        } else if (self->selected == SELECT_RIGHT && !self->has_plate && self->held == EMPTY)
            action = "PU:B";
        else if (self->selected == SELECT_LEFT && !self->has_plate && self->held == EMPTY)
            action = "PU:Q";
        else if (self->selected == SELECT_DOWN && !self->has_plate &&
                 (self->held == EMPTY || platable(self->held))) {
            if (self->held == EMPTY) action = "PL:NEW";
            else {
                char summary[5]; plate_summary(summary, plate_bit(self->held));
                FORMAT(dynamic, sizeof(dynamic), "PL:%s", summary); action = dynamic;
            }
        }
    } else if (same(station, "fridge")) {
        if (self->selected == SELECT_RIGHT && !self->has_plate && self->held == EMPTY)
            action = "PU:K";
        else if (self->selected == SELECT_LEFT && !self->has_plate && self->held == EMPTY)
            action = "PU:R";
    } else if (same(station, "cutting board")) {
        if (self->a_held && !self->has_plate &&
            (self->held == RAW_MEAT || self->held == LETTUCE || self->held == CHEESE)) action = "CH:S";
    } else if (same(station, "stove") &&
               (self->selected == SELECT_LEFT || self->selected == SELECT_RIGHT)) {
        int stove = self->selected == SELECT_RIGHT;
        char verb = 'C';
        if (self->held == CHOPPED_MEAT && self->stove_state[stove] == STOVE_EMPTY) verb = 'P';
        else if ((self->stove_state[stove] == STOVE_COOKED || self->stove_state[stove] == STOVE_WARNING) &&
                 ((!self->has_plate && self->held == EMPTY) ||
                  (self->has_plate && !(self->plate & PLATE_MEAT)))) verb = 'T';
        else if (self->stove_state[stove] == STOVE_BURNT && !self->has_plate && self->held == EMPTY)
            verb = 'X';
        if (verb == 'C') FORMAT(dynamic, sizeof(dynamic), "ST:%c:C:%s",
                                stove ? 'R' : 'L', stove_phase(self->stove_state[stove]));
        else FORMAT(dynamic, sizeof(dynamic), "ST:%c:%c", stove ? 'R' : 'L', verb);
        start_action(self, dynamic); return;
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
    if (self->nfc_enabled == 2) {
        /* A separate tick leaves the RF field off before fresh selection. */
        self->nfc_enabled = NFC_ENABLE() == 0;
        NFC_CLEAR();
        if (!self->nfc_enabled && self->status) LABEL_TEXT(self->status, "NFC RESTART FAILED - REOPEN APP");
        return;
    }
    NfcCard card = {{0}, {0}, 0, 0, 0, 0};
    int present = NFC_CARD(&card);
    if (self->nfc_clear_ticks && --self->nfc_clear_ticks == 0 && (!present || same_uid(&card, self))) {
        NFC_CLEAR(); self->nfc_rearm = 1; return;
    }
    if (!present) {
        if (self->nfc_rearm) { self->nfc_rearm = 0; self->nfc_seen_size = 0; self->nfc_retries = 0; }
        return;
    }
    if (!card.uid_size || card.uid_size > 10) return;
    if (self->nfc_rearm && same_uid(&card, self)) return;
    if (self->nfc_rearm) { self->nfc_rearm = 0; self->nfc_seen_size = 0; }
    if (same_uid(&card, self)) return;
    /* Match nfc_display: debounce failures too and clear after ~900 ms. */
    copy(self->nfc_seen, card.uid, card.uid_size); self->nfc_seen_size = (u8)card.uid_size;
    self->nfc_clear_ticks = 5;
    /* Match the stock Lua read_text binding's 256-byte NDEF output buffer. */
    char text[256];
    int error = NFC_TEXT(text, sizeof(text));
    if (error) {
        PRINT("OC_NATIVE|nfc_text_error=%u|uid_size=%u\n", (u32)error, card.uid_size);
        if ((error == NFC_RX_TIMEOUT || error == NFC_RX_TIMER_TIMEOUT) && self->nfc_retries < 2) {
            ++self->nfc_retries;
            NFC_STOP(); NFC_CLEAR();
            self->nfc_enabled = 2;
            self->nfc_seen_size = self->nfc_rearm = self->nfc_clear_ticks = 0;
            if (self->status) LABEL_TEXT(self->status, "NFC RESELECTING - HOLD TAG STILL");
            return;
        }
        char message[40];
        FORMAT(message, sizeof(message), "NFC READ %u - REMOVE AND RETAP", (u32)error);
        if (self->status) LABEL_TEXT(self->status, message);
        return;
    }
    self->nfc_retries = 0;
    text[sizeof(text) - 1] = 0;
    PRINT("OC_NATIVE|nfc=%s\n", text);
    if (self->status) {
        char message[64];
        FORMAT(message, sizeof(message), "NFC: %.24s%s", text, self->game_active ? "" : " / WAIT FOR HOST");
        LABEL_TEXT(self->status, message);
    }
    station_scan(self, text);
}

static u32 motion(void) {
    u32 xyz[3];
    if (SENSOR_ACCEL(xyz)) return 0;
    u32 value = xyz[0] & 0x7fffffffu;
    for (int i = 1; i < 3; ++i) if ((xyz[i] & 0x7fffffffu) > value) value = xyz[i] & 0x7fffffffu;
    return value;
}
static void snapshot(App *self, char *target) {
    if (self->has_plate) {
        target[0] = 'P'; plate_summary(target + 1, self->plate);
    } else if (self->held != EMPTY) {
        target[0] = 'H'; target[1] = item_short(self->held); target[2] = 0;
    } else {
        copy(target, "E----", 6);
    }
}

static void poll_motion(App *self) {
    if (!self->game_active || self->role != ROLE_PLAYER) return;
    if (self->tap_cooldown) --self->tap_cooldown;
    if (self->shake_cooldown) { --self->shake_cooldown; return; }
    u32 value = motion();
    if (value > SHAKE_ABS_BITS) {
        self->shake_cooldown = 25;
        if (self->b_held && (self->held != EMPTY || self->has_plate)) {
            char state[6], action[12]; snapshot(self, state);
            FORMAT(action, sizeof(action), "DROP:%s", state); start_action(self, action);
        } else if (self->a_held && self->has_plate) {
            char summary[5], action[9]; plate_summary(summary, self->plate);
            mark_ready(self, self->player);
            self->plate = self->has_plate = 0;
            FORMAT(action, sizeof(action), "SUB:%s", summary); start_action(self, action);
        } else {
            mark_ready(self, self->player); start_action(self, "READY");
        }
    } else if (!self->tap_cooldown && value > TAP_ABS_BITS) {
        char state[6], action[10]; snapshot(self, state);
        FORMAT(action, sizeof(action), "X:%s", state);
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
    u8 key = event & 0xff, kind = (event >> 8) & 0xff;
    if (self->role == ROLE_NONE && kind == 0) {
        if (key == 0) {
            self->role = ROLE_PLAYER_SETUP; self->player = 1;
            if (self->status) LABEL_TEXT(self->status, "CHOOSE FIXED PLAYER NUMBER");
        } else if (key == 8) {
            self->role = ROLE_HOST; self->phase = 1;
            if (self->status) LABEL_TEXT(self->status, "HOST STARTING RADIO");
        } else { unknown_combo(self); return; }
        render_game(self); return;
    }
    if (self->role == ROLE_PLAYER_SETUP && kind == 0) {
        if (key == 4) self->player = self->player == 1 ? 3 : self->player - 1;
        else if (key == 5) self->player = self->player == 3 ? 1 : self->player + 1;
        else if (key == 0) {
            self->role = ROLE_PLAYER; self->phase = 1;
            if (self->status) LABEL_TEXT(self->status, "PLAYER STARTING RADIO");
        } else { unknown_combo(self); return; }
        render_game(self); return;
    }
    if (self->phase != 2) return;
    if (self->role == ROLE_HOST && kind == 0 && key == 8 && !self->game_active && !self->wait_ticks) {
        PRINT("HTN26|GAME|START_GAME|120|3\n");
        apply_action(self, "GAME:START", 1); broadcast_control(self, 'S'); return;
    }
    if (key == 0) self->a_held = kind == 0;
    if (key == 1) self->b_held = kind == 0;
    if (kind == 1 && key == 0 && self->process_ticks) {
        self->held = self->process_from; self->process_ticks = 0; self->process_to = EMPTY;
        if (self->status) LABEL_TEXT(self->status, "CUT RESET - A RELEASED");
        render_game(self); LED_CLEAR(); LED_SHOW(); start_action(self, "CH:F");
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
    heap("entry"); self->ticks = 0; self->phase = 0;
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
    self->nfc_retries = 0;
    self->nfc_poll_ticks = self->nfc_clear_ticks = self->shake_cooldown = 0;
    self->process_from = self->process_to = self->stove_view = 0;
    self->stove_state[0] = self->stove_state[1] = 0;
    self->ready_ticks[0] = self->ready_ticks[1] = self->ready_ticks[2] = 0;
    self->process_ticks = self->stove_ticks[0] = self->stove_ticks[1] = self->stove_view_ticks = 0;
    self->game_ticks = self->control_sequence = self->tap_cooldown = 0;
    LED_CLEAR(); LED_SHOW();
    label(screen, "OVERCOOKED CONTROLLER", 7);
    self->status = label(screen, "Choose role to start radio", 34);
    self->info = label(screen, "HELD: EMPTY", 68);
    label(screen, "A player   START host   HOME exit", 214);
    render_game(self);
}

static void start_hardware(App *self) {
    self->phase = 2; heap("before_radio");
    int error = FN(0x42101718, int, void)();
    if (error) {
        PRINT("OC_NATIVE|nvs_preflight_failed=%d|radio_not_started\n", error);
        if (self->role == ROLE_HOST) PRINT("HTN26|GW|DOWN|0|0\n");
        if (self->status) LABEL_TEXT(self->status, "NVS ERROR / RADIO NOT STARTED");
        self->phase = 3; signal(self, 1, 0); heap("nvs_error"); return;
    }
    error = FN(0x42010dbe, int, u32, u32)(30, 30);
    if (!error) error = RADIO_START();
    heap("after_radio"); PRINT("OC_NATIVE|radio_result=%d\n", error);
    if (error) {
        if (self->role == ROLE_HOST) PRINT("HTN26|GW|DOWN|0|0\n");
        if (self->status) LABEL_TEXT(self->status, "RADIO ERROR / SEE SERIAL");
        self->phase = 3; signal(self, 1, 0); return;
    }
    u8 mac[6]; FN(0x42010fc2, void, u8 *)(mac);
    PRINT("OC_NATIVE|advertising_mac=%02x:%02x:%02x:%02x:%02x:%02x\n",
          mac[5], mac[4], mac[3], mac[2], mac[1], mac[0]);
    self->sequence = self->role == ROLE_HOST ? 0 :
                     FN(0x40389792, u32, void)() % 900000u + 100000u;
    const usize handler[4] = {(usize)self, 0, 0x4205e52a, (usize)receive};
    release(&self->active, 1); RADIO_HANDLER(handler); RADIO_PAUSE();
    self->nfc_enabled = self->role == ROLE_PLAYER && NFC_ENABLE() == 0;
    if (self->nfc_enabled) NFC_CLEAR();
    if (self->role == ROLE_HOST) {
        PRINT("HTN26|GW|UP|0|0\n");
        if (self->status) LABEL_TEXT(self->status, "HOST READY - PRESS START");
    } else if (self->status) LABEL_TEXT(self->status,
        self->nfc_enabled ? "PLAYER READY - WAIT FOR START" : "RADIO READY / NFC ERROR");
    LED(0, 0, 128, 0); LED_SHOW();
}

static void consume_radio(App *self) {
    char packet[45]; u8 peer[6]; u32 size = self->inbox_size;
    copy(packet, self->inbox, sizeof(packet)); copy(peer, self->peer, sizeof(peer));
    int rssi = self->rssi; release(&self->inbox_full, 0);
    int duplicate = size == self->last_size && equal(packet, self->last, size) && equal(peer, self->last_peer, 6);
    int event = packet[11] == 'E', control = packet[11] == 'G', ack = packet[11] == 'A';
    if (event && !self->game_active) event = 0;
    if (!duplicate) {
        for (usize i = 0; i < sizeof(self->last); ++i) self->last[i] = 0;
        copy(self->last, packet, size); self->last_size = size; copy(self->last_peer, peer, 6);
        PRINT("OC_NATIVE|rx=%s|peer=%02x:%02x:%02x:%02x:%02x:%02x|rssi=%d\n",
              packet, peer[5], peer[4], peer[3], peer[2], peer[1], peer[0], rssi);
        signal(self, 0, 0);
        if (control && self->role != ROLE_HOST) {
            u32 received_sequence = sequence_value(packet + 4);
            if (received_sequence > self->control_sequence) {
                self->control_sequence = received_sequence;
                apply_action(self, packet[13] == 'S' ? "GAME:START" : "GAME:END", 0);
            }
        }
        if (event) {
            if (same(packet + 16, "READY") || starts(packet + 16, "SUB:"))
                mark_ready(self, packet[14] - '0');
            if (self->role == ROLE_HOST) {
                ++self->received;
                PRINT("HTN26|RX|%02x:%02x:%02x:%02x:%02x:%02x|%d|%s\n",
                  peer[5], peer[4], peer[3], peer[2], peer[1], peer[0], rssi, packet);
            }
            apply_action(self, packet + 16, 0);
        }
        if (ack && self->wait_ticks && equal(packet + 4, self->pending + 4, 6)) {
            self->wait_ticks = self->advertise_ticks = 0; RADIO_PAUSE();
            if (self->status) LABEL_TEXT(self->status, "ACTION ACKNOWLEDGED");
            apply_action(self, self->pending + 16, 1);
            PRINT("OC_NATIVE|ack_matched=%.6s\n", packet + 4);
        }
    }
    /* Only the gateway acknowledges player events so a peer cannot stop a
       retry before the single Pi's host badge has observed and logged it. */
    if (self->role == ROLE_HOST && event &&
        (!duplicate || !self->advertise_ticks)) {
        char reply[16]; FORMAT(reply, sizeof(reply), "OC1|%.6s|A|OK", packet + 4);
        int error = transmit(self, reply, ACK_BYTES);
        if (!error) self->advertise_ticks = ACK_TICKS;
    }
}

static void tick(App *self) {
    if (self->phase == 1) start_hardware(self);
    if (self->phase != 2) return;
    if (acquire(&self->inbox_full)) consume_radio(self);
    for (int i = 0; i < 3; ++i) if (self->ready_ticks[i]) --self->ready_ticks[i];
    poll_nfc(self); poll_motion(self);

    if (self->process_ticks) {
        if (--self->process_ticks == 0) {
            self->held = self->process_to; self->process_from = self->process_to = EMPTY;
            if (self->status) LABEL_TEXT(self->status, "CUT COMPLETE");
            char action[7]; FORMAT(action, sizeof(action), "CH:D:%c", item_short(self->held));
            render_game(self); LED_CLEAR(); LED_SHOW(); start_action(self, action);
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
            PRINT("HTN26|GAME|GAME_END|3\n");
            apply_action(self, "GAME:END", 1); broadcast_control(self, 'E');
        } else if (!(self->game_ticks % 50)) render_game(self);
    }
    if (++self->ticks == 250) {
        self->ticks = 0; heap("idle");
        PRINT("OC_NATIVE|counts|tx=%u|rx=%u|errors=%u|dropped=%u\n",
              self->sent, self->received, self->errors, self->dropped);
        if (self->role == ROLE_HOST) PRINT("HTN26|GW|UP|%u|%u\n", self->received, self->dropped);
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
