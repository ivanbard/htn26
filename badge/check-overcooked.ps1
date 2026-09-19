$ErrorActionPreference = 'Stop'

function Require([bool]$condition, [string]$message) {
  if (-not $condition) { throw $message }
}

$files = @('overcooked-player.lua', 'overcooked-host.lua', 'overcooked-serve.lua')
$sources = @{}
foreach ($file in $files) {
  $source = Get-Content -Raw (Join-Path $PSScriptRoot $file)
  $sources[$file] = $source
  Require ($source -match '(?m)^api=2\r?$') "$file must use api=2"
  Require ($source -match '(?m)^heap_kb=48\r?$') "$file must use the 48 KiB heap"
  Require ($source -match '(?m)^wake_lock=1\r?$') "$file must hold the wake lock"
  Require ([Text.Encoding]::UTF8.GetByteCount($source) -le 65536) "$file exceeds the Lua upload limit"
  Require ($source -notmatch 'badge\.radio\.') "$file must use the transport adapter"
  foreach ($word in @('wifi', 'http', 'socket', 'lvgl', 'ble', 'coroutine', 'sleep')) {
    Require ($source -notmatch "badge\.$word") "unsupported badge.$word API used in $file"
  }
}

foreach ($packet in @(
  'OC1|H|9999|P',
  'OC1|E|9999|I:TOM',
  'OC1|V|9999|P:04',
  'OC1|A|9999|AABBCCDDEEFF|HOST',
  'OC1|R|9999|AABBCCDDEEFF|NOTYET'
)) {
  Require ([Text.Encoding]::UTF8.GetByteCount($packet) -le 44) "radio packet is over 44 bytes: $packet"
}

Require ($sources['overcooked-player.lua'] -match 'pending\[3\] < 4') 'player retries must remain bounded'
Require ($sources['overcooked-serve.lua'] -match 'pending\[3\] < 4') 'serving retries must remain bounded'
Require ($sources['overcooked-host.lua'] -match 'client\.seen\[number\]') 'host duplicate cache missing'
Require ($sources['overcooked-host.lua'] -match 'GAME\|SUBMIT') 'structured submission logging missing'

Write-Output 'Overcooked badge static checks passed.'
