-- The only hardware radio adapter; gameplay depends on the transport contract.
local M = {}

function M.new(radio, allowed)
  local enabled = false
  return {
    enable = function()
      if not enabled and allowed then enabled = radio.enable() == true end
      return enabled
    end,
    on_recv = function(handler) if enabled then radio.on_recv(handler) end end,
    send = function(payload)
      if not enabled or type(payload) ~= "string" or #payload < 1 or #payload > 44 then return false end
      return radio.send(payload)
    end,
    mac = function() if enabled then return radio.mac() end end,
    dropped = function() return enabled and radio.dropped() or 0 end,
    disable = function()
      if enabled then
        radio.on_recv(nil)
        radio.disable()
        enabled = false
      end
    end,
  }
end

return M
