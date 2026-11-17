# Every symbol an exe imports from libiomp5md.dll must be exported by the shim DLL next to it (plan §3 step 9).
# usage: check-imports.ps1 <exe> <shim libiomp5md.dll> [report file]
param([Parameter(Mandatory)][string]$Exe, [Parameter(Mandatory)][string]$Shim, [string]$Report)
. $PSScriptRoot\..\recipe\env.ps1
$lines = & dumpbin /nologo /imports $Exe
$imp = @(); $in = $false
foreach ($l in $lines) {
    if ($l -match '^\s+(\S+\.dll)\s*$') { $in = ($Matches[1] -ieq 'libiomp5md.dll'); continue }
    if ($in -and $l -match '^\s+[0-9A-F]+\s+(\S+)\s*$') { $imp += $Matches[1] }
}
$exp = @{}
foreach ($l in & dumpbin /nologo /exports $Shim) { if ($l -match '^\s+\d+\s+[0-9A-F]+\s+(?:[0-9A-F]{8}\s+)?(\S+)') { $exp[$Matches[1]] = $true } }
$missing = $imp | Where-Object { -not $exp.ContainsKey($_) }
$txt = @("imports from libiomp5md.dll: $($imp.Count)") + ($imp | Sort-Object) + @('', "not exported by the shim: $(@($missing).Count)") + $missing
if ($Report) { $txt | Set-Content -LiteralPath $Report }
if ($missing) { "FAIL: not exported by the shim: $($missing -join ', ')"; exit 1 } else { "OK: $($imp.Count) imports from libiomp5md.dll, all exported by the shim"; exit 0 }
