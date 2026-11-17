# Builds the 1.0.16 LLVM OpenMP shim exactly as scripts/setup-runtime.ps1 does (same pinned llvm-openmp package, same def generation,
# same scripts/openmp-shim/build.cmd) and publishes its import library as iomp5.lib (rustc, F10) and libiomp5md.lib (CMake find_library, F28).
. $PSScriptRoot\env.ps1
$pkg = Join-Path $Inputs 'src\llvm-openmp-23.1.5-h49e36cd_0.conda'
$want = 'F7B5E57C99568C23D97759820B9BB2EEAE47DFF5BA024DDC9DCDC08780DA527D'
if ((Get-FileHash -LiteralPath $pkg -Algorithm SHA256).Hash -ne $want) { throw 'llvm-openmp package checksum mismatch.' }
$omp = Join-Path $Root 'shim'
if (Test-Path -LiteralPath $omp) { Remove-Item -LiteralPath $omp -Recurse -Force }
New-Item -ItemType Directory -Path $omp -Force | Out-Null
$tar = Join-Path $env:SystemRoot 'System32\tar.exe'
& $tar -xf $pkg -C $omp
& $tar -xf (Get-ChildItem -LiteralPath $omp -Filter 'pkg-*.tar.zst').FullName -C $omp Library/bin/libomp.dll Library/lib/libomp.lib
$forwarded = foreach ($line in & dumpbin /nologo /headers (Join-Path $omp 'Library\lib\libomp.lib')) {
    if ($line -cmatch '^\s+Symbol name\s*:\s*(\S+)$') { $name = $Matches[1] }
    elseif ($line -cmatch '^\s+Type\s*:\s*(code|data)$') { "    $name=libomp.$name" + $(if ($Matches[1] -eq 'data') { ' DATA' }) }
}
Set-Content -LiteralPath (Join-Path $omp 'libiomp5md.def') -Encoding ascii -Value (@('LIBRARY libiomp5md', 'EXPORTS') + $forwarded)
& (Join-Path $RepoRoot 'scripts\openmp-shim\build.cmd') $Vcvars (Join-Path $omp 'Library\lib') $omp
if ($LASTEXITCODE -ne 0) { throw 'OpenMP shim build failed.' }
Copy-Item -LiteralPath (Join-Path $omp 'Library\bin\libomp.dll') -Destination $omp
$sem = & (Join-Path $omp 'semantics_test.exe')
if (($sem -join "`n") -cne ((Get-Content -LiteralPath (Join-Path $RepoRoot 'scripts\openmp-shim\semantics_expected.txt')) -join "`n")) { throw 'shim semantics differ' }
Copy-Item (Join-Path $omp 'libiomp5md.lib') (Join-Path $Lib 'libiomp5md.lib') -Force
Copy-Item (Join-Path $omp 'libiomp5md.lib') (Join-Path $Lib 'iomp5.lib') -Force
"shim OK: $((Get-ChildItem $omp -Filter 'libiomp5md.*' | % Name) -join ', ')"
