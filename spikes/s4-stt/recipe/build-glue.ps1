# Builds and tests the S4 glue crate (pure Rust) at BelowNormal priority (children inherit it). usage: build-glue.ps1 [-Test]
param([switch]$Test)
$ErrorActionPreference = 'Stop'
(Get-Process -Id $PID).PriorityClass = 'BelowNormal'
Set-Location (Join-Path $PSScriptRoot '..')
$env:CARGO_TARGET_DIR = Join-Path (Get-Location) 'target'
cargo build --release --offline -p s4-glue --color never
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
if ($Test) { cargo test --release --offline -p s4-glue --color never; exit $LASTEXITCODE }
