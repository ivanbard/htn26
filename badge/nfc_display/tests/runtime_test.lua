-- Host-only smoke test for the standalone app. It supplies the documented
-- API surface with a tiny fake so no badge hardware is required.
local state = { now = 0, card = nil, text = nil, error_text = nil, labels = {} }
local noop = function() end

local badge = {
  ui = {
    label = function(_, text)
      local label = { text = text }
      function label:align() end
      function label:style() end
      function label:set_text(value) self.text = value end
      function label:set_color() end
      state.labels[#state.labels + 1] = label
      return label
    end,
  },
  nfc = {
    enable = function() return true end,
    disable = noop,
    clear = function() state.card = nil end,
    card = function() return state.card end,
    read_text = function() return state.text, state.error_text end,
  },
  led = { clear = noop, show = noop, set_all = noop },
  sys = { ms = function() return state.now end },
  input = { BUTTON = { A = 1 }, KIND = { PRESSED = 1 } },
}

_G.badge = badge
dofile("badge/nfc_display/main.lua")
on_enter({})

local function shown(text)
  for _, label in ipairs(state.labels) do
    if string.find(label.text, text, 1, true) then return true end
  end
  return false
end

assert(shown("NO TAG"), "no-tag state is visible")
state.card = { uid = "04A1" }
state.text = "ING:TOMATO"
state.now = 200
on_tick()
assert(shown("TAG READ"), "successful tag state is visible")
assert(shown("ING:TOMATO"), "record text is visible")

state.now = 1200
on_tick()
state.now = 1400
on_tick()
assert(shown("NO TAG"), "removed tag returns to no-tag state")

state.card = { uid = "04B2" }
state.text = ""
state.error_text = nil
state.now = 1600
on_tick()
assert(shown("EMPTY TAG"), "empty tag is handled")

state.card = { uid = "04C3" }
state.text = nil
state.error_text = "bad NDEF"
state.now = 1800
on_tick()
assert(shown("READ FAILED"), "read failure is handled")

on_exit()
print("PASS: NFC display host smoke flow")
