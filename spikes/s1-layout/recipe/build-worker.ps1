# Builds thanham-worker against the recipe's engine. usage: build-worker.ps1 [-VerboseLib]
param([switch]$VerboseLib)
. $PSScriptRoot\env.ps1
Set-Location (Join-Path $PSScriptRoot '..')
$env:MKLROOT = Join-Path $Root 'mklroot'
$env:LIBRARY_PATH = $Lib
$env:S1_LIB = $Lib
$env:S1_CT2_INCLUDE = Join-Path $Root 'ct2-install\include'
if ($VerboseLib) { $env:S1_VERBOSE_LIB = '1' }
$env:RUSTFLAGS = '-C target-feature=+crt-static -W linker-messages'
cargo build --release -p thanham-worker --color never
exit $LASTEXITCODE
