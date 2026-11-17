# CTranslate2 4.8.5 as a static library matched to the wheel: threaded MKL (static, ILP64), oneDNN 3.1.1, Intel OpenMP ABI from the shim, no CUDA, /MT.
. $PSScriptRoot\env.ps1
$src = Join-Path $Inputs 'src\CTranslate2'
$bld = Join-Path $Root 'ct2-build'
$ins = Join-Path $Root 'ct2-install'
$mkl = Join-Path $Root 'mklroot'
# MKLROOT overlay: the PyPI-extracted oneMKL plus the shim's libiomp5md.lib, because intel-mkl-tool (iomp mode) refuses a root without one (RESULTS.md, stage 1).
if (-not (Test-Path -LiteralPath $mkl)) { Copy-Item -Recurse -LiteralPath (Join-Path $Inputs 'mklroot') -Destination $mkl }
Copy-Item (Join-Path $Lib 'libiomp5md.lib') (Join-Path $mkl 'lib\libiomp5md.lib') -Force
$env:MKLROOT = $mkl
if (Test-Path -LiteralPath $bld) { Remove-Item -LiteralPath $bld -Recurse -Force }
cmake -S $src -B $bld -G Ninja -DCMAKE_C_COMPILER=cl -DCMAKE_CXX_COMPILER=cl -DCMAKE_BUILD_TYPE=Release `
  '-DCMAKE_POLICY_VERSION_MINIMUM=3.5' -DCMAKE_POLICY_DEFAULT_CMP0091=NEW -DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded `
  '-DCMAKE_CXX_FLAGS=/EHsc' -DCMAKE_INSTALL_PREFIX="$ins" -DCMAKE_PREFIX_PATH="$Root\onednn-install" -DINTEL_ROOT="$Root" `
  -DBUILD_CLI=OFF -DBUILD_SHARED_LIBS=OFF -DWITH_MKL=ON -DWITH_DNNL=ON -DWITH_CUDA=OFF -DWITH_RUY=OFF -DOPENMP_RUNTIME=INTEL
if ($LASTEXITCODE -ne 0) { throw 'CT2 configure failed' }
cmake --build $bld --target install --parallel 3
if ($LASTEXITCODE -ne 0) { throw 'CT2 build failed' }
Get-ChildItem -Recurse -File -Filter *.lib $ins, $bld | ForEach-Object { "{0}  {1}" -f $_.FullName, $_.Length }
