param(
    # Where the engine goes: lib\, include\, mklroot\ and bin\ (see the end of this file).
    [Parameter(Mandatory)][string]$Out,
    # Build folder. Keep it short: oneDNN's object paths overflow MAX_PATH under a long root.
    [string]$Work = (Join-Path ([IO.Path]::GetTempPath()) 'ct2e')
)
# The STT engine of the native worker (plan section 3): CTranslate2 4.8.5 built to match the Python wheel's engine, which the
# wheel's own build script describes (python/tools/prepare_build_environment_windows.sh at v4.8.5): oneMKL 2025.3 threaded and
# static (ILP64), oneDNN 3.1.1 static with the wheel's flags, Intel OpenMP ABI, no CUDA. Spike S1 built it this way and found the
# Rust encoder bitwise equal to the wheel's (natively and under Intel SDE). Differences from S1, each needed by the worker:
# * /MD instead of /MT: the worker links the C runtime dynamically (worker-rs/.cargo/config.toml), as the wheel's DLL does. CT2's
#   CMakeLists.txt sets the static runtime itself for a static build, so that one line is changed after extraction (step 6).
# * The OpenMP ABI is the 1.0.16 LLVM shim (scripts/openmp-shim), as in S1; its link-time import library also declares the two
#   names that oneDNN's dead code references (S1 finding F-a (a), see Step-LinkLib).
# Every input is pinned by SHA-256; nothing else is downloaded. Run in a shell without the MSVC environment or with it.
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

$Inputs = @(
    # oneMKL 2025.3.0 from Intel's PyPI wheels (the release the wheel's oneAPI 2025.3.0.372 carries; S1 stage 1).
    @{ Name = 'mkl_static-2025.3.0-py2.py3-none-win_amd64.whl'; Sha256 = '2ff574382d21968e9ec1a45c067258c053588179e741a1983cda7f47587ac181'
       Url = 'https://files.pythonhosted.org/packages/9c/22/c099498c3294381349265dad4b1715edd8b739b6392c3076aa2a68231ae2/mkl_static-2025.3.0-py2.py3-none-win_amd64.whl' },
    @{ Name = 'mkl_devel-2025.3.0-py2.py3-none-win_amd64.whl'; Sha256 = '58e3c53d419a4431e6967089828df1ff2559958e6e5f30e491ec99593669fb12'
       Url = 'https://files.pythonhosted.org/packages/5e/d6/a0f24cf3193610debc8dceddcbac7d1510f68dbffe8f171ed5510c1e4f5e/mkl_devel-2025.3.0-py2.py3-none-win_amd64.whl' },
    @{ Name = 'mkl_include-2025.3.0-py2.py3-none-win_amd64.whl'; Sha256 = 'd8efcf39c37767c65abdf42976189475bab36f456e5e7e53bab00bc35c6a3209'
       Url = 'https://files.pythonhosted.org/packages/b9/d7/0445e80511e70b653291daaac068712a780ee0e00bb791d047eed0053c4b/mkl_include-2025.3.0-py2.py3-none-win_amd64.whl' },
    @{ Name = 'onemkl_license-2025.3.0-py2.py3-none-win_amd64.whl'; Sha256 = '35a179620bcadbcc3d17d74f7f72cab75889f3736b89685f6a68158325b65e91'
       Url = 'https://files.pythonhosted.org/packages/0e/8e/98ad8181e4af2ea7a6c7827ef6d24c73b6ee96a2890eacf46103f596195d/onemkl_license-2025.3.0-py2.py3-none-win_amd64.whl' },
    # oneDNN v3.1.1 (tag commit 64f6bcbcbab628e96f33a62c3e975f8535a7bde4).
    @{ Name = 'onednn-v3.1.1.tar.gz'; Sha256 = 'd1cd58f57b2308d362a9bc474acbc21524cb879cf5d8779b460c718f0fac82d6'
       Url = 'https://github.com/oneapi-src/oneDNN/archive/refs/tags/v3.1.1.tar.gz' },
    # CTranslate2 4.8.5 as ct2rs-sys 0.11.2 vendors it (the crate the worker links against; upstream v4.8.5 = 7f59ae11).
    @{ Name = 'ct2rs-sys-0.11.2.crate'; Sha256 = 'fd0bb0e75956342681515ad9bc0644573090aa16a8bdc47d107c4c4b278113fe'
       Url = 'https://static.crates.io/crates/ct2rs-sys/ct2rs-sys-0.11.2.crate' },
    # The LLVM OpenMP runtime behind the shim, the package scripts/setup-runtime.ps1 pins.
    @{ Name = 'llvm-openmp-23.1.5-h49e36cd_0.conda'; Sha256 = 'f7b5e57c99568c23d97759820b9bb2eeae47dff5ba024ddc9dcdc08780da527d'
       Url = 'https://conda.anaconda.org/conda-forge/win-64/llvm-openmp-23.1.5-h49e36cd_0.conda' }
)
# The two names oneDNN's dead code references: the marker every MSVC /openmp object carries, and a vcomp entry point that only
# oneDNN's Winograd backward-weights (training) code uses. link.exe reports them unresolved before /OPT:REF drops that code.
$LinkOnly = '_You_must_link_with_Microsoft_OpenMP_library', '_vcomp_for_static_simple_init'

$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$Work = [IO.Path]::GetFullPath($Work)
$Out = [IO.Path]::GetFullPath($Out)
$tar = Join-Path $env:SystemRoot 'System32\tar.exe'  # bsdtar: zip, .conda, tar.gz; tar on PATH may be Git's GNU tar
$in = Join-Path $Work 'inputs'
$lib = Join-Path $Work 'lib'
foreach ($d in $Work, $in, $lib) { New-Item -ItemType Directory -Force -Path $d | Out-Null }

# MSVC environment (cl, lib, link, dumpbin, cmake, ninja), unless the caller already has it.
if (-not (Get-Command cl.exe -ErrorAction SilentlyContinue)) {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    $vs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    $vcvars = Join-Path $vs 'VC\Auxiliary\Build\vcvars64.bat'
    cmd /c "`"$vcvars`" >nul && set" | ForEach-Object { if ($_ -match '^([^=]+)=(.*)$' -and $Matches[1] -ne 'PSModulePath') { Set-Item "Env:$($Matches[1])" $Matches[2] } }
}
$env:VSLANG = '1033'  # English tool output; the dumpbin parsing below expects it

foreach ($i in $Inputs) {
    $file = Join-Path $in $i.Name
    if (-not (Test-Path -LiteralPath $file) -or (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $i.Sha256) {
        Invoke-WebRequest -Uri $i.Url -OutFile $file
    }
    if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $i.Sha256) { throw "$($i.Name): checksum mismatch." }
}

# 1. The OpenMP shim, as setup-runtime.ps1 builds it (same package, same forwarding .def, same build.cmd and semantics check).
$omp = Join-Path $Work 'shim'
if (Test-Path -LiteralPath $omp) { Remove-Item -LiteralPath $omp -Recurse -Force }
New-Item -ItemType Directory -Path $omp | Out-Null
& $tar -xf (Join-Path $in 'llvm-openmp-23.1.5-h49e36cd_0.conda') -C $omp
& $tar -xf (Get-ChildItem -LiteralPath $omp -Filter 'pkg-*.tar.zst').FullName -C $omp Library/bin/libomp.dll Library/lib/libomp.lib
$forwarded = foreach ($line in & dumpbin /nologo /headers (Join-Path $omp 'Library\lib\libomp.lib')) {
    if ($line -cmatch '^\s+Symbol name\s*:\s*(\S+)$') { $name = $Matches[1] }
    elseif ($line -cmatch '^\s+Type\s*:\s*(code|data)$') { "    $name=libomp.$name" + $(if ($Matches[1] -eq 'data') { ' DATA' }) }
}
Set-Content -LiteralPath (Join-Path $omp 'libiomp5md.def') -Encoding ascii -Value (@('LIBRARY libiomp5md', 'EXPORTS') + $forwarded)
$vcvarsArg = if ($vcvars) { $vcvars } else { Join-Path $env:VCINSTALLDIR 'Auxiliary\Build\vcvars64.bat' }
& (Join-Path $repo 'scripts\openmp-shim\build.cmd') $vcvarsArg (Join-Path $omp 'Library\lib') $omp
Copy-Item -LiteralPath (Join-Path $omp 'Library\bin\libomp.dll') -Destination $omp
$semantics = & (Join-Path $omp 'semantics_test.exe')
if (($semantics -join "`n") -cne ((Get-Content -LiteralPath (Join-Path $repo 'scripts\openmp-shim\semantics_expected.txt')) -join "`n")) { throw 'Shim semantics differ.' }

# 2. The link-time import library: every export of the shim DLL plus the two link-only names (S1 F-a (a)). The DLL is unchanged;
#    check-link.ps1 asserts that the linked worker imports neither name and only names the shim exports.
$data = @{}
foreach ($l in Get-Content -LiteralPath (Join-Path $omp 'libiomp5md.def')) { if ($l -match '^\s+(\S+)=libomp\.\S+\s+DATA\s*$') { $data[$Matches[1]] = $true } }
$exports = foreach ($l in & dumpbin /nologo /exports (Join-Path $omp 'libiomp5md.dll')) { if ($l -match '^\s+\d+\s+[0-9A-F]+\s+(?:[0-9A-F]{8}\s+)?(\S+)') { $Matches[1] } }
$names = @($exports) + $LinkOnly | Sort-Object -Unique -CaseSensitive
$implib = Join-Path $Work 'iomp-link'
New-Item -ItemType Directory -Force -Path $implib | Out-Null
Set-Content -LiteralPath "$implib\libiomp5md.def" -Encoding ascii -Value (@('LIBRARY libiomp5md', 'EXPORTS') + ($names | ForEach-Object { "    $_" + $(if ($data[$_]) { ' DATA' }) }))
lib /nologo /def:"$implib\libiomp5md.def" /machine:x64 /out:"$implib\libiomp5md.lib" | Out-Null
foreach ($n in 'libiomp5md.lib', 'iomp5.lib') { Copy-Item "$implib\libiomp5md.lib" (Join-Path $lib $n) -Force }  # CMake's find_library, rustc

# 3. Empty cublas.lib and cublasLt.lib: ct2rs-sys 0.11.2 `system` asks for them on Windows even without CUDA (plan F42). No
#    public symbols, so a real CUDA reference fails to link instead of resolving.
$stubs = Join-Path $Work 'stubs'
New-Item -ItemType Directory -Force -Path $stubs | Out-Null
Set-Content -LiteralPath "$stubs\empty.c" -Value '/* intentionally empty: no symbols */' -Encoding ascii
cl /nologo /c /MD "$stubs\empty.c" /Fo:"$stubs\empty.obj" | Out-Null
foreach ($n in 'cublas', 'cublasLt') { lib /nologo /OUT:"$lib\$n.lib" "$stubs\empty.obj" | Out-Null }

# 4. oneMKL root: the wheels' Library\ trees merged, plus the shim's link-time libiomp5md.lib, which intel-mkl-tool requires under
#    MKLROOT in iomp mode and then links (S1 stage 1).
$mkl = Join-Path $Work 'mklroot'
if (Test-Path -LiteralPath $mkl) { Remove-Item -LiteralPath $mkl -Recurse -Force }
New-Item -ItemType Directory -Path $mkl | Out-Null
foreach ($whl in $Inputs.Name | Where-Object { $_ -like '*.whl' }) {
    $x = Join-Path $Work ('whl-' + $whl.Split('-')[0])
    if (Test-Path -LiteralPath $x) { Remove-Item -LiteralPath $x -Recurse -Force }
    New-Item -ItemType Directory -Path $x | Out-Null
    & $tar -xf (Join-Path $in $whl) -C $x
    Get-ChildItem -LiteralPath (Get-ChildItem -LiteralPath $x -Directory -Filter '*.data').FullName -Recurse -Directory -Filter Library |
        ForEach-Object { Copy-Item -Path (Join-Path $_.FullName '*') -Destination $mkl -Recurse -Force }
    Remove-Item -LiteralPath $x -Recurse -Force
}
Copy-Item (Join-Path $lib 'libiomp5md.lib') (Join-Path $mkl 'lib\libiomp5md.lib') -Force
$env:MKLROOT = $mkl

# 5. oneDNN 3.1.1 static with the wheel's flags.
$src = Join-Path $Work 'src'
if (Test-Path -LiteralPath $src) { Remove-Item -LiteralPath $src -Recurse -Force }
New-Item -ItemType Directory -Path $src | Out-Null
& $tar -xzf (Join-Path $in 'onednn-v3.1.1.tar.gz') -C $src
& $tar -xzf (Join-Path $in 'ct2rs-sys-0.11.2.crate') -C $src
$cmakeCommon = @('-G', 'Ninja', '-DCMAKE_C_COMPILER=cl', '-DCMAKE_CXX_COMPILER=cl', '-DCMAKE_BUILD_TYPE=Release', '-DCMAKE_POLICY_VERSION_MINIMUM=3.5',
    '-DCMAKE_POLICY_DEFAULT_CMP0091=NEW', '-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreadedDLL')
$dnnl = Join-Path $Work 'onednn-install'
cmake -S (Join-Path $src 'oneDNN-3.1.1') -B (Join-Path $Work 'onednn-build') @cmakeCommon -DCMAKE_INSTALL_PREFIX="$dnnl" `
    -DONEDNN_LIBRARY_TYPE=STATIC -DONEDNN_BUILD_EXAMPLES=OFF -DONEDNN_BUILD_TESTS=OFF -DONEDNN_ENABLE_WORKLOAD=INFERENCE `
    '-DONEDNN_ENABLE_PRIMITIVE=CONVOLUTION;REORDER' -DONEDNN_BUILD_GRAPH=OFF
cmake --build (Join-Path $Work 'onednn-build') --target install
Copy-Item (Join-Path $dnnl 'lib\dnnl.lib') $lib -Force

# 6. CTranslate2 4.8.5 static: MKL, oneDNN, Intel OpenMP (the shim's import library), no CUDA, no Ruy. Its CMakeLists.txt forces
# the static C runtime when BUILD_SHARED_LIBS is OFF (a normal variable, so -DCMAKE_MSVC_RUNTIME_LIBRARY cannot override it).
$cmakeLists = Join-Path $src 'ct2rs-sys-0.11.2\CTranslate2\CMakeLists.txt'
$staticCrt = 'set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")'
$text = [IO.File]::ReadAllText($cmakeLists)
if (-not $text.Contains($staticCrt)) { throw "CTranslate2's CMakeLists.txt no longer has: $staticCrt" }
[IO.File]::WriteAllText($cmakeLists, $text.Replace($staticCrt, 'set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>DLL")'))
$ct2 = Join-Path $Work 'ct2-install'
cmake -S (Join-Path $src 'ct2rs-sys-0.11.2\CTranslate2') -B (Join-Path $Work 'ct2-build') @cmakeCommon '-DCMAKE_CXX_FLAGS=/EHsc' `
    -DCMAKE_INSTALL_PREFIX="$ct2" -DCMAKE_PREFIX_PATH="$dnnl" -DINTEL_ROOT="$Work" -DBUILD_CLI=OFF -DBUILD_SHARED_LIBS=OFF `
    -DWITH_MKL=ON -DWITH_DNNL=ON -DWITH_CUDA=OFF -DWITH_RUY=OFF -DOPENMP_RUNTIME=INTEL
cmake --build (Join-Path $Work 'ct2-build') --target install
Copy-Item (Join-Path $ct2 'lib\ctranslate2.lib'), (Join-Path $Work 'ct2-build\third_party\cpu_features\cpu_features.lib') $lib -Force
foreach ($static in 'ctranslate2.lib', 'cpu_features.lib', 'dnnl.lib') {
    if (dumpbin /directives (Join-Path $lib $static) | Select-String -SimpleMatch 'LIBCMT' -Quiet) { throw "$static asks for the static C runtime." }
}

# The engine. lib\: what the worker links (ct2rs-sys `system`: ctranslate2, cpu_features, cublas stubs, iomp5; the worker's build.rs:
# dnnl). mklroot\: MKLROOT for intel-onemkl-prebuild (only the three static libraries it links, and the headers). include\: CT2's
# headers for the worker's C++ glue. bin\: the shim and libomp.dll that check-link.ps1 checks the imports against.
if (Test-Path -LiteralPath $Out) { Remove-Item -LiteralPath $Out -Recurse -Force }
foreach ($d in 'lib', 'bin', 'mklroot\lib') { New-Item -ItemType Directory -Force -Path (Join-Path $Out $d) | Out-Null }
Copy-Item (Join-Path $lib '*.lib') (Join-Path $Out 'lib')
Copy-Item -Recurse (Join-Path $ct2 'include') $Out
Copy-Item -Recurse (Join-Path $mkl 'include') (Join-Path $Out 'mklroot')
foreach ($n in 'mkl_core.lib', 'mkl_intel_ilp64.lib', 'mkl_intel_thread.lib', 'libiomp5md.lib') { Copy-Item (Join-Path $mkl "lib\$n") (Join-Path $Out 'mklroot\lib') }
Copy-Item (Join-Path $omp 'libiomp5md.dll'), (Join-Path $omp 'libomp.dll') (Join-Path $Out 'bin')
Get-ChildItem -LiteralPath $Out -Recurse -File -Include *.lib, *.dll | ForEach-Object { '{0,12}  {1}' -f $_.Length, $_.FullName.Substring($Out.Length + 1) }
