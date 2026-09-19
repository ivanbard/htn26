$ErrorActionPreference = 'Stop'
$source = Get-Content -Raw (Join-Path $PSScriptRoot 'overcooked.lua')

function Require([bool]$condition, [string]$message) {
  if (-not $condition) { throw $message }
}

Require ($source -match '(?m)^api=2$') 'manifest must use api=2'
Require ($source -match '(?m)^heap_kb=48$') 'manifest must use the 48 KiB heap'
Require ($source -match '(?m)^wake_lock=1$') 'manifest must hold the wake lock'
Require ($source.Length -le 65536) 'main.lua exceeds the documented 64 KiB limit'

$forbidden = @('wifi', 'http', 'socket', 'lvgl', 'ble', 'coroutine', 'sleep')
foreach ($word in $forbidden) {
  Require ($source -notmatch "badge\.$word") "unsupported badge.$word API used"
}

$packets = @(
  'OC1|H|9999|P',
  'OC1|E|9999|I:TOM',
  'OC1|E|9999|P:04',
  'OC1|V|9999|P:04',
  'OC1|A|9999|AABBCCDDEEFF|HOST',
  'OC1|U|9999|AABBCCDDEEFF|S04:999999',
  'OC1|R|9999|AABBCCDDEEFF|NOTYET'
)
foreach ($packet in $packets) {
  Require ([Text.Encoding]::UTF8.GetByteCount($packet) -le 44) "radio packet is over 44 bytes: $packet"
}

Require ($source -match 'MAX_TRIES = 800, 4') 'radio retries must remain bounded'
Require ($source -match 'client\.cache\[number\]') 'host duplicate cache missing'
Require ($source -match 'if prior then badge\.radio\.send\(prior\) return end') 'duplicates must resend their prior result'
Require ($source -match 'badge\.nfc\.clear\(\)') 'NFC last-seen state is never cleared'
Require ($source -match 'badge\.sys\.log\("GAME\|SUBMIT\|"') 'structured submission logging missing'

Write-Output 'Overcooked badge static checks passed.'
