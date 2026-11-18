param(
    [ValidateSet('base', 'separation')][string]$Profile = 'base',
    [string]$Destination = (Join-Path $PSScriptRoot $(if ($Profile -eq 'separation') { '..\runtime-separation' } else { '..\runtime' })),
    [string]$FfmpegDirectory
)
# Builds the private runtime that the installer bundles (runtime/python + runtime/ffmpeg).
# -Profile base (default): the installer's runtime, from worker/requirements-base.lock, with FFmpeg.
# -Profile separation: Python + PyTorch + Demucs from worker/requirements-separation.lock, no FFmpeg. It is the input of
# scripts/build_pack.py, which turns it into the downloadable separation pack (.github/workflows/pack.yml).
# Does not modify system Python or PATH and needs no administrator rights.
$ErrorActionPreference = 'Stop'
$PythonVersion = '3.11.18'
# BtbN LGPL shared build, pinned by name and SHA-256 (autobuild tags expire; update the pin together).
$FfmpegTag = 'autobuild-2026-11-10-12-39'
$FfmpegAsset = 'ffmpeg-n9.0.2-48-gd4070a14ce-win64-lgpl-shared-9.0'
$FfmpegSha256 = 'cdc19c20aa80d46f78cfc69c8d87430ee34990864e30379db02d1447cd111e83'
# conda-forge llvm-openmp (LLVM OpenMP runtime, Apache-2.0 WITH LLVM-exception), pinned by URL and SHA-256. It replaces
# Intel's OpenMP runtime; scripts/openmp-shim/vcomp_shim.c explains the shim built against it.
$LlvmOpenmpUrl = 'https://conda.anaconda.org/conda-forge/win-64/llvm-openmp-23.1.5-h49e36cd_0.conda'
$LlvmOpenmpSha256 = 'f7b5e57c99568c23d97759820b9bb2eeae47dff5ba024ddc9dcdc08780da527d'

$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$destinationPath = [IO.Path]::GetFullPath($Destination)
New-Item -ItemType Directory -Path $destinationPath -Force | Out-Null
$managed = Join-Path $destinationPath 'managed'
$oldManaged = $env:UV_PYTHON_INSTALL_DIR
$oldVslang = $env:VSLANG
try {
    $env:UV_PYTHON_INSTALL_DIR = $managed
    & uv python install $PythonVersion
    if ($LASTEXITCODE -ne 0) { throw 'Private Python download failed.' }
    $source = Get-ChildItem -LiteralPath $managed -Directory | Where-Object Name -Like "cpython-$PythonVersion*windows*" | Select-Object -First 1
    if (-not $source) { throw 'Managed Python distribution not found.' }
    $pythonDir = Join-Path $destinationPath 'python'
    if (Test-Path -LiteralPath $pythonDir) { Remove-Item -LiteralPath $pythonDir -Recurse -Force }
    New-Item -ItemType Directory -Path $pythonDir -Force | Out-Null
    Get-ChildItem -LiteralPath $source.FullName -Force | Copy-Item -Destination $pythonDir -Recurse -Force
    $python = Join-Path $pythonDir 'python.exe'
    if (-not (Test-Path -LiteralPath $python)) { throw 'Portable interpreter is missing.' }
    # This is our private copy, not uv's managed install; allow installing into it.
    Remove-Item -LiteralPath (Join-Path $pythonDir 'Lib\EXTERNALLY-MANAGED') -Force -ErrorAction SilentlyContinue
    # Lock enumerates the deliberately minimal inference closure. VieNeu's Gradio
    # application dependencies are not needed by the desktop worker.
    & uv pip install --python $python --no-deps --compile-bytecode -r (Join-Path $root "worker\requirements-$Profile.lock")
    if ($LASTEXITCODE -ne 0) { throw 'CPU runtime dependency installation failed.' }
    # onnxruntime/ctranslate2 need the MSVC C++ runtime, which clean Windows lacks. Deploy the
    # redistributable CRT app-locally next to python.exe (permitted by the Visual Studio redist terms).
    $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
    $vs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    $crt = Get-ChildItem -Path "$vs\VC\Redist\MSVC" -Directory | ForEach-Object { Join-Path $_.FullName 'x64\Microsoft.VC143.CRT' } | Where-Object { Test-Path -LiteralPath $_ } | Sort-Object -Descending | Select-Object -First 1
    if (-not $crt) { throw 'MSVC redistributable CRT (VC\Redist\MSVC\*\x64\Microsoft.VC143.CRT) not found.' }
    Get-ChildItem -LiteralPath $crt -Filter '*.dll' | Copy-Item -Destination $pythonDir -Force
    # Unused by the worker; keeps the installer smaller.
    foreach ($rel in @('Lib\test', 'Lib\idlelib', 'Lib\tkinter', 'Lib\turtledemo', 'tcl', 'Lib\site-packages\pip')) {
        $p = Join-Path $pythonDir $rel
        if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Recurse -Force }
    }
    # Package test suites and ONNX conversion tools are never imported at runtime; they also
    # carry the deepest paths, which break makensis (MAX_PATH) and long install folders.
    $site = Join-Path $pythonDir 'Lib\site-packages'
    Get-ChildItem -LiteralPath $site -Directory -Recurse -Filter 'tests' | Sort-Object { $_.FullName.Length } -Descending | ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force }
    Remove-Item -LiteralPath (Join-Path $site 'onnxruntime\tools') -Recurse -Force -ErrorAction SilentlyContinue
    # Torch's C++ headers, import libraries and build tools only serve compiling extensions.
    foreach ($rel in @('include', 'bin', 'share')) { Remove-Item -LiteralPath (Join-Path $site "torch\$rel") -Recurse -Force -ErrorAction SilentlyContinue }
    Remove-Item -Path (Join-Path $site 'torch\lib\*.lib') -Force -ErrorAction SilentlyContinue

    # Replace Intel's OpenMP runtime (libiomp5md.dll in torch and ctranslate2, Intel EULA) with LLVM's libomp.dll behind
    # the shim in scripts/openmp-shim, which keeps the libiomp5md.dll name and adds the MSVC vcomp entry points.
    $ompPkg = Join-Path ([IO.Path]::GetTempPath()) ([IO.Path]::GetFileName($LlvmOpenmpUrl))
    if (-not (Test-Path -LiteralPath $ompPkg) -or (Get-FileHash -LiteralPath $ompPkg -Algorithm SHA256).Hash -ne $LlvmOpenmpSha256) {
        Invoke-WebRequest -Uri $LlvmOpenmpUrl -OutFile $ompPkg
    }
    if ((Get-FileHash -LiteralPath $ompPkg -Algorithm SHA256).Hash -ne $LlvmOpenmpSha256) { throw 'llvm-openmp package checksum mismatch.' }
    $omp = "$ompPkg-build"
    if (Test-Path -LiteralPath $omp) { Remove-Item -LiteralPath $omp -Recurse -Force }
    New-Item -ItemType Directory -Path $omp -Force | Out-Null
    # System32's bsdtar reads the .conda zip and its zstd tarball; tar on PATH may be Git's GNU tar.
    $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
    & $tar -xf $ompPkg -C $omp
    if ($LASTEXITCODE -ne 0) { throw 'llvm-openmp package extraction failed.' }
    & $tar -xf (Get-ChildItem -LiteralPath $omp -Filter 'pkg-*.tar.zst').FullName -C $omp Library/bin/libomp.dll Library/lib/libomp.lib
    if ($LASTEXITCODE -ne 0) { throw 'llvm-openmp package extraction failed.' }
    $libomp = Join-Path $omp 'Library\bin\libomp.dll'
    $shim = Join-Path $omp 'libiomp5md.dll'
    $msvcVersion = (Get-Content -LiteralPath (Join-Path $vs 'VC\Auxiliary\Build\Microsoft.VCToolsVersion.default.txt')).Trim()
    $dumpbin = Join-Path $vs "VC\Tools\MSVC\$msvcVersion\bin\Hostx64\x64\dumpbin.exe"
    $env:VSLANG = '1033' # English tool output on a localized Visual Studio; the dumpbin parsing below expects it
    # The shim forwards every libomp export, read from the package's import library (which also says which exports are
    # data and must be marked DATA), so a new pin re-forwards without a checked-in list.
    $forwarded = foreach ($line in & $dumpbin /nologo /headers (Join-Path $omp 'Library\lib\libomp.lib')) {
        if ($line -cmatch '^\s+Symbol name\s*:\s*(\S+)$') { $name = $Matches[1] }
        elseif ($line -cmatch '^\s+Type\s*:\s*(code|data)$') { "    $name=libomp.$name" + $(if ($Matches[1] -eq 'data') { ' DATA' }) }
    }
    Set-Content -LiteralPath (Join-Path $omp 'libiomp5md.def') -Encoding ascii -Value (@('LIBRARY libiomp5md', 'EXPORTS') + $forwarded)
    & (Join-Path $PSScriptRoot 'openmp-shim\build.cmd') (Join-Path $vs 'VC\Auxiliary\Build\vcvars64.bat') (Join-Path $omp 'Library\lib') $omp
    if ($LASTEXITCODE -ne 0) { throw 'OpenMP shim build failed.' }
    Copy-Item -LiteralPath $libomp -Destination $omp
    $semantics = & (Join-Path $omp 'semantics_test.exe')
    if ($LASTEXITCODE -ne 0 -or ($semantics -join "`n") -cne ((Get-Content -LiteralPath (Join-Path $PSScriptRoot 'openmp-shim\semantics_expected.txt')) -join "`n")) {
        throw "OpenMP shim results differ from Microsoft's vcomp140 (scripts/openmp-shim/semantics_expected.txt): $($semantics -join "`n")"
    }
    # libomp.dll goes next to every shim: an STT job loads only ctranslate2's copy, a separation job only torch's.
    # Delete before copying: uv hardlinks installed files to its cache, so writing over them would change the cache
    # and every other environment linked to it.
    foreach ($dir in (Get-ChildItem -LiteralPath $pythonDir -Recurse -File -Filter 'libiomp5md.dll').DirectoryName) {
        Get-ChildItem -LiteralPath $dir -File | Where-Object Name -In 'libiomp5md.dll', 'libomp.dll' | Remove-Item -Force
        Copy-Item -LiteralPath $shim, $libomp -Destination $dir
    }
    Get-ChildItem -LiteralPath $pythonDir -Recurse -File -Filter 'libiompstubs5md.dll' | Remove-Item -Force
    # PyAV's FFmpeg links the GPL x264 and x265 encoders, but the app only decodes. Replace both DLLs, under the same
    # file names (deleted first, as above), with the stand-ins in scripts/encoder-stubs, which encode nothing.
    $replacements = @{ 'libiomp5md.dll' = $shim }
    if ($Profile -eq 'base') {
        & (Join-Path $PSScriptRoot 'encoder-stubs\build.cmd') (Join-Path $vs 'VC\Auxiliary\Build\vcvars64.bat') $omp
        if ($LASTEXITCODE -ne 0) { throw 'Encoder stub build failed.' }
        foreach ($n in 'x264', 'x265') {
            foreach ($real in Get-ChildItem -LiteralPath (Join-Path $site 'av.libs') -File -Filter "lib$n-*.dll") {
                Remove-Item -LiteralPath $real.FullName -Force
                Copy-Item -LiteralPath (Join-Path $omp "$n.dll") -Destination $real.FullName
                $replacements[$real.Name] = Join-Path $omp "$n.dll"
            }
        }
        # NVIDIA cuDNN ships in the ctranslate2 wheel for GPU use. Nothing imports it; ctranslate2 only preloads every DLL
        # in its folder, so the CPU runtime does not need it. A missing or locked file stops the build.
        Remove-Item -LiteralPath (Join-Path $site 'ctranslate2\cudnn64_9.dll') -Force
    }
    # Fail the build if an Intel OpenMP, x264/x265 or cuDNN binary remains, or if any binary imports a symbol its
    # replacement does not export (e.g. a torch or ctranslate2 bump that starts using another _vcomp_* entry point).
    $pes = Get-ChildItem -LiteralPath $pythonDir -Recurse -File -Include '*.dll', '*.pyd', '*.exe'
    $banned = $pes | Where-Object {
        $v = $_.VersionInfo
        "$($v.ProductName) $($v.CompanyName) $($v.FileDescription)" -match 'Intel.*OpenMP|x264|x265|HEVC video encoder|H\.264.*encoder|cuDNN' -or
        ($_.Name -match '^libx26[45]-' -and $_.Length -gt 64KB) -or $_.Name -match '^cudnn'
    }
    if ($banned) { throw "Intel OpenMP, x264/x265 or cuDNN binaries remain: $($banned.FullName -join ', ')" }
    foreach ($dll in $replacements.Keys) {
        $exports = & $dumpbin /nologo /exports $replacements[$dll] | ForEach-Object { if ($_ -cmatch '^\s+\d+\s+[0-9A-F]+\s+(?:[0-9A-F]{8}\s+)?(\S+)') { $Matches[1] } }
        $imports = for ($i = 0; $i -lt $pes.Count; $i += 50) {
            $file = $null; $inBlock = $false
            foreach ($line in & $dumpbin /nologo /imports:$dll $pes[$i..($i + 49)].FullName) {
                if ($line -cmatch '^Dump of file (.+)$') { $file = $Matches[1]; $inBlock = $false }
                elseif ($line -match "^\s+$([regex]::Escape($dll))$") { $inBlock = $true }
                elseif ($line -cmatch '^\s+Summary$') { $inBlock = $false }
                elseif ($inBlock -and $line -cmatch '^\s+[0-9A-F]{1,4} (\S+)$') { [pscustomobject]@{ File = $file; Symbol = $Matches[1] } }
                elseif ($inBlock -and $line -cmatch '^\s+Ordinal\s') { throw "$file imports $dll by ordinal; the replacement's ordinals differ from the original's." }
            }
        }
        if (-not $imports) { throw "No runtime binary imports ${dll}: the import scan is broken, or its replacement is no longer needed." }
        $missing = @($imports | Where-Object Symbol -notin $exports)
        if ($missing) { throw "The replacement $dll does not export: $(($missing | ForEach-Object { "$($_.Symbol) (imported by $($_.File))" }) -join ', ')" }
        Write-Output "Import check: all $(@($imports.Symbol | Sort-Object -Unique).Count) symbols that $((@($imports.File | Sort-Object -Unique) | Split-Path -Leaf) -join ', ') import from $dll are among the replacement's $($exports.Count) exports."
    }
    Remove-Item -LiteralPath $omp -Recurse -Force
    Remove-Item -LiteralPath $managed -Recurse -Force

    $bin = Join-Path $destinationPath 'ffmpeg'
    if ($Profile -eq 'separation') {
        # The pack carries no FFmpeg: a separation job gets the installer's through the request's ffmpeg_path.
    } else {
    if (Test-Path -LiteralPath $bin) { Remove-Item -LiteralPath $bin -Recurse -Force }
    New-Item -ItemType Directory -Path $bin -Force | Out-Null
    if ($FfmpegDirectory) {
        Get-ChildItem -LiteralPath $FfmpegDirectory -File | Where-Object { $_.Name -in 'ffmpeg.exe', 'ffprobe.exe' -or $_.Extension -eq '.dll' } | Copy-Item -Destination $bin
        Write-Warning 'Custom FFmpeg directory: include its exact license and source offer before distribution.'
    } else {
        $zip = Join-Path ([IO.Path]::GetTempPath()) "$FfmpegAsset.zip"
        if (-not (Test-Path -LiteralPath $zip) -or (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash -ne $FfmpegSha256) {
            Invoke-WebRequest -Uri "https://github.com/BtbN/FFmpeg-Builds/releases/download/$FfmpegTag/$FfmpegAsset.zip" -OutFile $zip
        }
        if ((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash -ne $FfmpegSha256) { throw 'FFmpeg archive checksum mismatch.' }
        $unpack = Join-Path ([IO.Path]::GetTempPath()) "$FfmpegAsset-unpack"
        if (Test-Path -LiteralPath $unpack) { Remove-Item -LiteralPath $unpack -Recurse -Force }
        Expand-Archive -LiteralPath $zip -DestinationPath $unpack
        $build = Join-Path $unpack $FfmpegAsset
        Get-ChildItem -LiteralPath (Join-Path $build 'bin') -File | Where-Object { $_.Name -ne 'ffplay.exe' } | Copy-Item -Destination $bin
        Copy-Item -LiteralPath (Join-Path $build 'LICENSE.txt') -Destination (Join-Path $bin 'LICENSE.txt')
        Set-Content -LiteralPath (Join-Path $bin 'SOURCE.txt') -Encoding utf8 -Value @(
            "FFmpeg LGPL shared build by BtbN/FFmpeg-Builds, release $FfmpegTag, asset $FfmpegAsset.zip (sha256 $FfmpegSha256).",
            'Source and build scripts: https://github.com/BtbN/FFmpeg-Builds and https://ffmpeg.org/download.html')
        Remove-Item -LiteralPath $unpack -Recurse -Force
    }
    foreach ($name in @('ffmpeg.exe', 'ffprobe.exe')) {
        if (-not (Test-Path -LiteralPath (Join-Path $bin $name))) { throw "Missing $name in runtime." }
    }
    }

    $request = @{protocol=1;id='setup';operation='health';payload=@{profile=$Profile}} | ConvertTo-Json -Compress
    $health = $request | & $python -I -X utf8 (Join-Path $root 'worker\main.py')
    if ($LASTEXITCODE -ne 0) { throw "Worker health failed: $health" }
    # The worker exits 0 with ready:false when a module does not import (e.g. a native DLL that fails to load).
    if (-not ($health | Select-Object -Last 1 | ConvertFrom-Json).result.ready) { throw "Worker health is not ready: $health" }
    Write-Output $health
    if ($Profile -eq 'base') {
        # The health run above may have written .pyc files, and 419 .py files (mostly stdlib) shipped without one. Compile
        # everything in timestamp mode now: NSIS restores each file's build-time write time on install and on update, so
        # the shipped headers stay valid and a job writes almost nothing. py312_intrinsics.py is a SyntaxError under 3.11.
        & $python -I -m compileall -q -x py312_intrinsics (Join-Path $pythonDir 'Lib')
        if ($LASTEXITCODE -ne 0) { throw 'Bytecode compilation failed.' }
        # The Sandbox gate hashes every shipped .pyc against this list after its jobs (new .pyc files are information only).
        $sha = [Security.Cryptography.SHA256]::Create()
        $pycList = foreach ($f in Get-ChildItem -LiteralPath $pythonDir -Recurse -File -Filter '*.pyc' | Sort-Object FullName) {
            $stream = [IO.File]::OpenRead($f.FullName)
            try { $hash = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() } finally { $stream.Dispose() }
            "$hash  $($f.FullName.Substring($pythonDir.Length + 1).Replace('\', '/'))"
        }
        [IO.File]::WriteAllText((Join-Path $pythonDir 'pyc-sha256.txt'), (($pycList -join "`n") + "`n"))
        Write-Output "Wrote pyc-sha256.txt ($(@($pycList).Count) files)."
    }
    Write-Output "Runtime ($Profile) ready at $destinationPath. Tauri bundles the base one as resources/runtime. Models are downloaded separately in the app."
} finally {
    $env:UV_PYTHON_INSTALL_DIR = $oldManaged
    $env:VSLANG = $oldVslang
}
