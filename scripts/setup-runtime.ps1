param(
    [string]$Destination = (Join-Path $PSScriptRoot '..\runtime'),
    [string]$FfmpegDirectory
)
# Builds the private runtime that the installer bundles (runtime/python + runtime/ffmpeg).
# Does not modify system Python or PATH and needs no administrator rights.
$ErrorActionPreference = 'Stop'
$PythonVersion = '3.11.18'
# BtbN LGPL shared build, pinned by name and SHA-256 (autobuild tags expire; update the pin together).
$FfmpegTag = 'autobuild-2026-11-10-12-39'
$FfmpegAsset = 'ffmpeg-n9.0.2-48-gd4070a14ce-win64-lgpl-shared-9.0'
$FfmpegSha256 = 'cdc19c20aa80d46f78cfc69c8d87430ee34990864e30379db02d1447cd111e83'

$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$destinationPath = [IO.Path]::GetFullPath($Destination)
New-Item -ItemType Directory -Path $destinationPath -Force | Out-Null
$managed = Join-Path $destinationPath 'managed'
$oldManaged = $env:UV_PYTHON_INSTALL_DIR
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
    & uv pip install --python $python --no-deps --compile-bytecode -r (Join-Path $root 'worker\requirements-cpu.lock')
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
    Remove-Item -LiteralPath $managed -Recurse -Force

    $bin = Join-Path $destinationPath 'ffmpeg'
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

    $request = @{protocol=1;id='setup';operation='health';payload=@{}} | ConvertTo-Json -Compress
    $health = $request | & $python -I -X utf8 (Join-Path $root 'worker\main.py')
    if ($LASTEXITCODE -ne 0) { throw "Worker health failed: $health" }
    Write-Output $health
    Write-Output "Runtime ready at $destinationPath. Tauri bundles it as resources/runtime. Models are downloaded separately in the app."
} finally {
    $env:UV_PYTHON_INSTALL_DIR = $oldManaged
}
