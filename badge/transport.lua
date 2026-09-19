-- Badge deployment choice. Keep false until the firmware radio issue is fixed.
-- The desktop runner injects a local endpoint under this same module name.
return require("radio_transport").new(badge.radio, false)
