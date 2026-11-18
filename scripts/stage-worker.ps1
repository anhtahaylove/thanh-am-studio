param(
    [string]$Exe = (Join-Path $PSScriptRoot '..\worker-rs\target\release\thanham-worker.exe'),
    [string]$OnnxRuntime = (Join-Path $PSScriptRoot '..\runtime\python\Lib\site-packages\onnxruntime\capi\onnxruntime.dll'),
    [string]$Stage = (Join-Path $PSScriptRoot '..\worker-rs\stage')
)
# Stages the native worker for the installer: tauri.conf.json maps worker-rs/stage/ to worker/ next to main.py. The exe is
# +crt-static; the VC143 runtime DLLs go beside it because onnxruntime.dll (loaded by full path from this folder) imports them,
# and the pinned ONNX Runtime comes from the private runtime's wheel so both workers run the same build.
$ErrorActionPreference = 'Stop'
foreach ($f in $Exe, $OnnxRuntime) { if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { throw "Missing $f" } }
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$install = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $install) { throw 'Visual Studio with the C++ tools is needed for the VC143 runtime DLLs.' }
$crt = Get-ChildItem (Join-Path $install 'VC\Redist\MSVC\*\x64\Microsoft.VC143.CRT') -Directory | Sort-Object { [version]($_.FullName -replace '.*\\MSVC\\([^\\]+)\\.*', '$1') } | Select-Object -Last 1
if (-not $crt) { throw 'Microsoft.VC143.CRT not found.' }
if (Test-Path -LiteralPath $Stage) { Remove-Item -LiteralPath $Stage -Recurse -Force }
New-Item -ItemType Directory -Force $Stage | Out-Null
Copy-Item -LiteralPath $Exe, $OnnxRuntime -Destination $Stage
foreach ($name in 'msvcp140.dll', 'msvcp140_1.dll', 'vcruntime140.dll', 'vcruntime140_1.dll') { Copy-Item -LiteralPath (Join-Path $crt.FullName $name) -Destination $Stage }
Get-ChildItem $Stage | Select-Object Name, Length
