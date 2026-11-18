# Builds s4-encode against the S1 recipe's engine libs in C:\s1b (read-only use; built by spikes/s1-layout/recipe 01-05),
# then stages the 1.0.16 runtime's OpenMP shim and LLVM libomp next to the exe (S1: bitwise equal with them).
. $PSScriptRoot\..\..\s1-layout\recipe\env.ps1   # MSVC env, $Root = C:\s1b, $Lib, BelowNormal
Set-Location (Join-Path $PSScriptRoot '..')
$env:MKLROOT = Join-Path $Root 'mklroot'
$env:LIBRARY_PATH = $Lib
$env:S1_LIB = $Lib
$env:S1_CT2_INCLUDE = Join-Path $Root 'ct2-install\include'
$env:CARGO_TARGET_DIR = Join-Path (Get-Location) 'target'
cargo build --release --offline -p s4-encode --color never
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$ct2 = 'C:\Users\User\Documents\Codex\2026-11-10\c-program-files-j2team-tts-j2team-2\work\rm\baseline-1.0.16\runtime\python\Lib\site-packages\ctranslate2'
Copy-Item (Join-Path $ct2 'libiomp5md.dll'), (Join-Path $ct2 'libomp.dll') (Join-Path $env:CARGO_TARGET_DIR 'release') -Force
Get-FileHash (Join-Path $env:CARGO_TARGET_DIR 'release\*.dll'), (Join-Path $env:CARGO_TARGET_DIR 'release\s4-encode.exe') | Format-Table -AutoSize | Out-String -Width 200
