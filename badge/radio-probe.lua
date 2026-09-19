--[==[badge-app
slug=oc_radio_probe
name=Radio Probe
icon=TEST
api=2
heap_kb=48
wake_lock=1
]==]

-- Diagnostic only: open once with the IDE console connected; HOME exits.
local enabled = false

function on_enter(root)
  badge.sys.log("PROBE|firmware=" .. badge.sys.version())
  badge.sys.log("PROBE|before radio|free=" .. badge.sys.stats().free_heap)
  enabled = badge.radio.enable()
  badge.sys.log("PROBE|after radio|enabled=" .. tostring(enabled))
  local status = badge.ui.label(root, enabled and "Radio started - HOME exits" or "Radio failed - HOME exits")
  status:align("center", 0, 0)
end

function on_exit()
  if enabled then badge.radio.disable() end
end
