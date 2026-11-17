# DIAGNOSTIC ONLY (never shipped): the same worker linked against Intel's real libiomp5md.lib, to see which libiomp5md.dll imports the wheel-equivalent link produces.
. $PSScriptRoot\env.ps1
Set-Location (Join-Path $PSScriptRoot '..')
$env:CARGO_TARGET_DIR = 'C:\s1b\target-real'
$env:MKLROOT = 'C:\s1b\mklroot-real'
$env:LIBRARY_PATH = 'C:\s1b\lib-real'
$env:S1_LIB = 'C:\s1b\lib-real'
$env:S1_CT2_INCLUDE = Join-Path $Root 'ct2-install\include'
$env:S1_VERBOSE_LIB = '1'
$env:RUSTFLAGS = '-C target-feature=+crt-static -W linker-messages'
cargo build --release -p thanham-worker --color never
exit $LASTEXITCODE
