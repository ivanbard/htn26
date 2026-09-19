-- In-process broadcast bus. Each foreground app gets its own MAC and endpoint.
-- Delivery enters the exact on_recv callback used by the radio adapter.
local M = {}

function M.new()
  local peers = {}
  local bus = {}
  function bus.endpoint(mac)
    assert(type(mac) == "string" and string.match(mac,
      "^%x%x:%x%x:%x%x:%x%x:%x%x:%x%x$"), "invalid local MAC")
    mac = string.upper(mac)
    assert(not peers[mac], "duplicate local MAC")
    local peer = { enabled = false }
    peers[mac] = peer
    return {
      enable = function() peer.enabled = true return true end,
      on_recv = function(handler) peer.receive = handler end,
      mac = function() return mac end,
      dropped = function() return 0 end,
      disable = function() peer.enabled, peer.receive = false, nil end,
      send = function(payload)
        if not peer.enabled or type(payload) ~= "string" or #payload < 1 or #payload > 44 then return false end
        for address, target in pairs(peers) do
          if address ~= mac and target.enabled and target.receive then
            target.receive(mac, -40, payload)
          end
        end
        return true -- queued/delivered to listeners, not a game acknowledgement
      end,
    }
  end
  return bus
end

return M
