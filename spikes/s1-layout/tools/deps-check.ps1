# dumpbin /dependents for every exe and dll in a stage folder; asserts the allowed set (plan §6 S1).
# usage: deps-check.ps1 <stage folder> <report file>
param([Parameter(Mandatory)][string]$Stage, [Parameter(Mandatory)][string]$Report)
. $PSScriptRoot\..\recipe\env.ps1
$shipped = @{}; Get-ChildItem $Stage -File | Where-Object { $_.Extension -in '.exe', '.dll' } | ForEach-Object { $shipped[$_.Name.ToLower()] = $true }
$sys32 = 'C:\Windows\System32'
$lines = @(); $bad = @()
foreach ($f in Get-ChildItem $Stage -File | Where-Object { $_.Extension -in '.exe', '.dll' } | Sort-Object Name) {
    $deps = & dumpbin /nologo /dependents $f.FullName | ForEach-Object { if ($_ -match '^\s+(\S+\.(?:dll|DLL))\s*$') { $Matches[1] } }
    $lines += "== $($f.Name)"
    foreach ($d in $deps) {
        $l = $d.ToLower()
        $kind = if ($shipped[$l]) { 'shipped' } elseif ($l -like 'api-ms-win-*' -or $l -like 'ext-ms-win-*') { 'system(api-set)' } elseif (Test-Path (Join-Path $sys32 $d)) { 'system' } else { 'MISSING' }
        if ($l -eq 'vcomp140.dll' -or $l -like 'vcomp*') { $kind = 'FORBIDDEN' }
        if ($kind -in 'MISSING', 'FORBIDDEN') { $bad += "$($f.Name) -> $d ($kind)" }
        $lines += ("   {0,-40} {1}" -f $d, $kind)
    }
}
$lines | Set-Content -LiteralPath $Report
if ($bad) { "FAIL:`n" + ($bad -join "`n"); exit 1 } else { 'OK: only system DLLs, shipped files; no VCOMP*'; exit 0 }
