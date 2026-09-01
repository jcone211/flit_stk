#Requires -Version 7.0
param([int]$Port = 17321)
$env:FLIT_BRIDGE_PORT = $Port
$node = Get-Command node -ErrorAction Stop
& $node.Source (Join-Path $PSScriptRoot 'server.js')
