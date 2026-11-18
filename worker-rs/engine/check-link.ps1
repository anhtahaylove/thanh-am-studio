param(
    # thanham-worker.exe built with `--features ct2`, with the shim libiomp5md.dll and libomp.dll next to it.
    [Parameter(Mandatory)][string]$Exe,
    # build-engine.ps1's output folder.
    [Parameter(Mandatory)][string]$Engine
)
# The two checks plan section 7 (bundle 2) asks for on the S1 F-a fixes, plus the link checks of plan section 3:
# (a) the link-time libiomp5md.lib declares the two dead-code names, the exe imports neither, and every name the exe imports from
#     libiomp5md.dll is exported by the shim; no VCOMP140.DLL; the cublas stubs hold no symbols;
# (b) `thanham-worker health` shows the GEMM backend CTranslate2 chose, which must be the wheel's choice on this CPU: CT2_USE_MKL
#     when set, else MKL on a GenuineIntel CPU and oneDNN on any other. Without the .CRT$XCT initializer of native/ct2_glue.cc an
#     Intel CPU gets oneDNN (S1 F-a (b)).
$ErrorActionPreference = 'Stop'
if (-not (Get-Command dumpbin.exe -ErrorAction SilentlyContinue)) {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    $vs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    cmd /c "`"$(Join-Path $vs 'VC\Auxiliary\Build\vcvars64.bat')`" >nul && set" | ForEach-Object { if ($_ -match '^([^=]+)=(.*)$' -and $Matches[1] -ne 'PSModulePath') { Set-Item "Env:$($Matches[1])" $Matches[2] } }
}
$env:VSLANG = '1033'
$linkOnly = '_You_must_link_with_Microsoft_OpenMP_library', '_vcomp_for_static_simple_init'
$fail = @()

$declared = foreach ($l in & dumpbin /nologo /exports (Join-Path $Engine 'lib\libiomp5md.lib')) { if ($l -match '^\s+(\S+)\s*$') { $Matches[1] } }
foreach ($n in $linkOnly) { if ($declared -cnotcontains $n) { $fail += "lib\libiomp5md.lib does not declare $n" } }

$imports = @(); $in = $false
foreach ($l in & dumpbin /nologo /imports $Exe) {
    if ($l -match '^\s+(\S+\.dll)\s*$') { $in = ($Matches[1] -ieq 'libiomp5md.dll'); continue }
    if ($in -and $l -match '^\s+[0-9A-F]+\s+(\S+)\s*$') { $imports += $Matches[1] }
}
if (-not $imports) { $fail += 'the exe imports nothing from libiomp5md.dll (is the engine linked?)' }
foreach ($n in $linkOnly) { if ($imports -ccontains $n) { $fail += "the exe imports $n" } }
$shim = @{}
foreach ($l in & dumpbin /nologo /exports (Join-Path $Engine 'bin\libiomp5md.dll')) { if ($l -match '^\s+\d+\s+[0-9A-F]+\s+(?:[0-9A-F]{8}\s+)?(\S+)') { $shim[$Matches[1]] = $true } }
foreach ($n in $imports) { if (-not $shim.ContainsKey($n)) { $fail += "the shim does not export $n" } }
$deps = foreach ($l in & dumpbin /nologo /dependents $Exe) { if ($l -match '^\s+(\S+\.dll)\s*$') { $Matches[1] } }
if ($deps -match '^vcomp') { $fail += "the exe depends on $($deps -match '^vcomp')" }
foreach ($n in 'cublas', 'cublasLt') {
    if ((& dumpbin /nologo /linkermember:1 (Join-Path $Engine "lib\$n.lib") | Out-String) -notmatch '\b0 public symbols') { $fail += "lib\$n.lib has symbols" }
}
# (c) every object of the engine's own libraries comes from the cl that compiler.txt names, of the wheel's toolset (cl 19.44): the
#     @comp.id each object carries, (product << 16) | build.
$compiler = (Get-Content -LiteralPath (Join-Path $Engine 'compiler.txt') -Raw).Trim()
$build = if ($compiler -match '^19\.44\.(\d+)$') { [uint32]$Matches[1] } else { $fail += "compiler.txt names cl $compiler, not 19.44"; 0 }
foreach ($n in 'ctranslate2.lib', 'cpu_features.lib', 'dnnl.lib') {
    $other = foreach ($l in & dumpbin /nologo /symbols (Join-Path $Engine "lib\$n")) {
        if ($l -match '^\S+\s+([0-9A-F]{8})\s.*@comp\.id') {
            $id = [Convert]::ToUInt32($Matches[1], 16)
            if (($id -shr 16) -ne 0 -and ($id -band 0xFFFF) -ne $build) { '{0:X8}' -f $id }
        }
    }
    if ($other) { $fail += "lib\$n has objects from another compiler: $(($other | Sort-Object -Unique) -join ', ')" }
}
"engine compiler: cl $compiler"
"imports from libiomp5md.dll: $($imports.Count) ($(($imports | Sort-Object) -join ', '))"
"dependents: $($deps -join ', ')"

# The worker reads one protocol request on stdin; the last event is the result.
$result = '{"protocol":1,"id":"check-link","operation":"health","payload":{}}' | & $Exe | Select-Object -Last 1 | ConvertFrom-Json
$stt = $result.result.stt_engine  # not $engine: PowerShell names are case-insensitive and $Engine is the [string] parameter
"health stt_engine: $($stt | ConvertTo-Json -Compress)"
# The wheel's own choice (backend.cc mayiuse_mkl): CT2_USE_MKL when set ("1", "true" or "TRUE" is MKL), else MKL on GenuineIntel only.
$useMkl = if ($env:CT2_USE_MKL) { $env:CT2_USE_MKL -cin '1', 'true', 'TRUE' } else { $stt.cpu_vendor -ceq 'GenuineIntel' }
$want = if ($useMkl) { 'MKL' } else { 'DNNL' }
if ($stt.gemm_int8 -cne $want) { $fail += "CTranslate2 chose $($stt.gemm_int8) on a $($stt.cpu_vendor) CPU; the wheel chooses $want" }

if ($fail) { throw "Link checks failed:`n$($fail -join "`n")" }
'OK: link-only names declared and not imported; every libiomp5md.dll import exported by the shim; no VCOMP; empty cublas stubs; engine objects from cl 19.44; backend as the wheel'
