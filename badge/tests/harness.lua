-- Desktop-only badge API boundary. Gameplay is loaded unchanged in separate envs.
local M = {}
function M.new()
  local world = { now = 0, apps = {}, packets = {}, logs = {} }
  world.bus = dofile("badge/local_transport.lua").new()
  function world.app(path, mac)
    local app = { labels = {}, logs = {}, store = {}, nfc_on = false }
    app.transport = world.bus.endpoint(mac)
    local send = app.transport.send
    app.transport.send = function(payload)
      world.packets[#world.packets + 1] = { mac = mac, payload = payload }
      return send(payload)
    end
    local function noop() end
    local badge = {
      radio = setmetatable({}, { __index = function() error("hardware radio touched") end }),
      sys = {
        ms = function() return world.now end,
        log = function(message)
          app.logs[#app.logs + 1] = message
          world.logs[#world.logs + 1] = message
        end,
      },
      store = {
        get_int = function(key, default) return app.store[key] or default end,
        set_int = function(key, value) app.store[key] = value end,
      },
      nfc = {
        enable = function() app.nfc_on = true return true end,
        disable = function() app.nfc_on = false end,
        clear = function() app.card = nil end,
        card = function() return app.card end,
        read_text = function() return app.text end,
      },
      led = { clear = noop, show = noop, set = noop, set_all = noop },
      input = { BUTTON = { A = 1, START = 2 }, KIND = { PRESSED = 1, RELEASED = 2 } },
      ui = { label = function(_, text)
        local label = { text = text, align = noop, style = noop, set_font_size = noop, set_color = noop }
        function label:set_text(value) self.text = value end
        app.labels[#app.labels + 1] = label
        return label
      end },
    }
    app.env = setmetatable({ badge = badge, require = function(name)
      assert(name == "transport", "unexpected module " .. name)
      return app.transport
    end }, { __index = _G })
    assert(loadfile(path, "t", app.env))()
    app.env.on_enter({})
    world.apps[#world.apps + 1] = app
    function app.shows(text)
      for _, label in ipairs(app.labels) do
        if string.find(label.text, text, 1, true) then return true end
      end
      return false
    end
    return app
  end
  function world.tick(ms)
    world.now = world.now + (ms or 20)
    for _, app in ipairs(world.apps) do app.env.on_tick() end
  end
  function world.settle()
    for _ = 1, 4 do world.tick() end
  end
  function world.scan(app, text, uid)
    assert(app.nfc_on, "NFC must be enabled")
    app.card, app.text = { uid = uid }, text
    world.tick(200)
    world.settle()
  end
  function world.count(message)
    local count = 0
    for _, line in ipairs(world.logs) do if line == message then count = count + 1 end end
    return count
  end
  return world
end
return M
