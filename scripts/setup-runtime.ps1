param(
    [string]$Destination = (Join-Path $PSScriptRoot '..\runtime'),
    [string]$FfmpegDirectory
)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$destinationPath = [IO.Path]::GetFullPath($Destination)
New-Item -ItemType Directory -Path $destinationPath -Force | Out-Null
$managed = Join-Path $destinationPath 'managed'
$oldManaged = $env:UV_PYTHON_INSTALL_DIR
try {
    $env:UV_PYTHON_INSTALL_DIR = $managed
    & uv python install 3.11.18
    if ($LASTEXITCODE -ne 0) { throw 'Private Python download failed.' }
    $source = Get-ChildItem -LiteralPath $managed -Directory | Where-Object Name -Like 'cpython-3.11*windows*' | Select-Object -First 1
    if (-not $source) { throw 'Managed Python distribution not found.' }
    $pythonDir = Join-Path $destinationPath 'python'
    New-Item -ItemType Directory -Path $pythonDir -Force | Out-Null
    Get-ChildItem -LiteralPath $source.FullName -Force | Copy-Item -Destination $pythonDir -Recurse -Force
    $python = Join-Path $pythonDir 'python.exe'
    if (-not (Test-Path -LiteralPath $python)) { throw 'Portable interpreter is missing.' }
    # Lock enumerates the deliberately minimal inference closure. VieNeu's Gradio
    # application dependencies are not needed by the desktop worker.
    & uv pip install --python $python --no-deps -r (Join-Path $root 'worker\requirements-cpu.lock')
    if ($LASTEXITCODE -ne 0) { throw 'CPU runtime dependency installation failed.' }
    if ($FfmpegDirectory) {
        $bin = Join-Path $destinationPath 'ffmpeg'
        New-Item -ItemType Directory -Path $bin -Force | Out-Null
        foreach ($name in @('ffmpeg.exe', 'ffprobe.exe')) {
            $sourceFile = Join-Path $FfmpegDirectory $name
            if (-not (Test-Path -LiteralPath $sourceFile)) { throw "Missing $name in FFmpeg directory." }
            Copy-Item -LiteralPath $sourceFile -Destination (Join-Path $bin $name) -Force
        }
        Write-Warning 'Before public distribution, include this exact FFmpeg build license, configuration and source offer as required. The script does not certify redistribution compliance.'
    }
    $request = @{protocol=1;id='setup';operation='health';payload=@{}} | ConvertTo-Json -Compress
    $request | & $python (Join-Path $root 'worker\main.py')
    if ($LASTEXITCODE -ne 0) { throw 'Worker health failed.' }
    Write-Output "Runtime ready at $destinationPath. Set THANHAM_PYTHON=$python for development. Models are downloaded separately."
} finally {
    $env:UV_PYTHON_INSTALL_DIR = $oldManaged
}
