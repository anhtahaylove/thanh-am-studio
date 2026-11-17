# Link-time import library for the shim (plan §3 step 4 + 9).
#
# The shim's libiomp5md.lib exports only what the shim DLL exports. Two symbols are referenced by oneDNN objects that the linker
# finds unresolved BEFORE it drops dead code (/OPT:REF): `_You_must_link_with_Microsoft_OpenMP_library` (the marker every /openmp
# object references) and `_vcomp_for_static_simple_init` (used only by oneDNN's Winograd backward-weights, training-only code).
# Intel's own libiomp5md.lib declares both, and with it the final link does not import either (the wheel's ctranslate2.dll does not
# import them either). So the recipe's link-time library = every export of the shim DLL + those two names. The DLL is unchanged.
# Safety net: if a LIVE reference to a name the shim does not export ever appears, it shows up in `dumpbin /imports` and
# tools/check-imports.ps1 fails the build; a dead one is harmless by construction.
. $PSScriptRoot\env.ps1
$shimDir = Join-Path $Root 'shim'
$def = Get-Content -LiteralPath (Join-Path $shimDir 'libiomp5md.def')
$data = @{}; foreach ($l in $def) { if ($l -match '^\s+(\S+)=libomp\.\S+\s+DATA\s*$') { $data[$Matches[1]] = $true } }
$names = foreach ($l in & dumpbin /nologo /exports (Join-Path $shimDir 'libiomp5md.dll')) { if ($l -match '^\s+\d+\s+[0-9A-F]+\s+(?:[0-9A-F]{8}\s+)?(\S+)') { $Matches[1] } }
$extra = '_You_must_link_with_Microsoft_OpenMP_library', '_vcomp_for_static_simple_init'
$all = @($names) + $extra | Sort-Object -Unique -CaseSensitive
$out = Join-Path $Root 'iomp-link'
New-Item -ItemType Directory -Force -Path $out | Out-Null
Set-Content -LiteralPath "$out\libiomp5md.def" -Encoding ascii -Value (@('LIBRARY libiomp5md', 'EXPORTS') + ($all | ForEach-Object { "    $_" + $(if ($data[$_]) { ' DATA' }) }))
lib /nologo /def:"$out\libiomp5md.def" /machine:x64 /out:"$out\libiomp5md.lib" | Out-Null
Copy-Item "$out\libiomp5md.lib" (Join-Path $Lib 'libiomp5md.lib') -Force
Copy-Item "$out\libiomp5md.lib" (Join-Path $Lib 'iomp5.lib') -Force
Copy-Item "$out\libiomp5md.lib" (Join-Path $Root 'mklroot\lib\libiomp5md.lib') -Force
"link-time libiomp5md.lib: $($names.Count) shim exports + $($extra.Count) link-only names = $($all.Count); $($data.Count) DATA"
