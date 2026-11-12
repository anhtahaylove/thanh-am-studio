# Runs inside Windows Sandbox: clean Windows, no Python/FFmpeg, repo and installer mapped read-only.
# -Only runs the listed packaged.mjs phases (network on); -Gate N runs the N-segment gate instead.
param([string]$Repo = 'C:\repo', [string]$Installer = 'C:\installer', [string]$Out = 'C:\out', [string]$Only = '', [int]$Gate = 0)
$ErrorActionPreference = 'Continue'
$log = Join-Path $Out 'sandbox.log'
function Log($m) { "$(Get-Date -Format o) $m" | Tee-Object -FilePath $log -Append }
Log "user=$env:USERNAME os=$([Environment]::OSVersion.VersionString) cpu=$((Get-CimInstance Win32_Processor).Name) ram=$([math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory/1GB,1))GB"
foreach ($c in 'python', 'python3', 'py', 'ffmpeg', 'ffprobe', 'uv') { Log "PATH $c => $((Get-Command $c -ErrorAction SilentlyContinue).Source)" }
$setup = Get-ChildItem -LiteralPath $Installer -Filter '*-setup.exe' | Select-Object -First 1
$t = Get-Date
$p = Start-Process -FilePath $setup.FullName -ArgumentList '/S' -Wait -PassThru
Log "install exit=$($p.ExitCode) seconds=$([math]::Round(((Get-Date)-$t).TotalSeconds))"
$exe = Get-ChildItem -LiteralPath $env:LOCALAPPDATA, "$env:LOCALAPPDATA\Programs" -Filter 'thanh-am-studio.exe' -Recurse -Depth 1 -ErrorAction SilentlyContinue | Select-Object -First 1
$dir = $exe.Directory
Log "installed $($exe.FullName) size=$([math]::Round((Get-ChildItem -LiteralPath $dir.FullName -Recurse -File | Measure-Object Length -Sum).Sum/1MB))MB"
$env:Path = "C:\node;$env:Path"
$health = '{"protocol":1,"id":"h","operation":"health","payload":{}}' | & (Join-Path $dir.FullName 'runtime\python\python.exe') -I -X utf8 (Join-Path $dir.FullName 'worker\main.py')
Log "health $health"
Get-Process thanh-am-studio -ErrorAction SilentlyContinue | Stop-Process -Force
$harness = Join-Path $Repo 'e2e\desktop\packaged.mjs'
$env:THANHAM_LONG_AUDIO = Join-Path $Installer 'long.mp3' # optional input of the longstt phase (long.txt = reference)
$env:THANHAM_UX_AUDIO = Join-Path $Installer 'dialogue.wav' # optional input of the ux and features phases (two speakers for features)
if ($Gate) {
    & node (Join-Path $Repo 'e2e\desktop\gate.mjs') $exe.FullName $Out $Gate *>> $log
    Log "gate exit=$LASTEXITCODE"
} elseif ($Only) {
    foreach ($phase in $Only -split ',') {
        & node $harness $exe.FullName $Out $phase *>> $log
        Log "phase $phase exit=$LASTEXITCODE"
    }
} else {
    foreach ($phase in 'full', 'reopen', 'turbo') {
        & node $harness $exe.FullName $Out $phase *>> $log
        Log "phase $phase exit=$LASTEXITCODE"
    }
    Get-NetAdapter | Disable-NetAdapter -Confirm:$false
    Log "network disabled: $((Test-NetConnection huggingface.co -Port 443 -WarningAction SilentlyContinue).TcpTestSucceeded)"
    foreach ($phase in 'offline', 'export') {
        & node $harness $exe.FullName $Out $phase *>> $log
        Log "phase $phase exit=$LASTEXITCODE"
    }
}
Get-ChildItem "$env:LOCALAPPDATA\studio.thanham.desktop\jobs" -Recurse -Filter worker.log | Select-Object -Last 3 | ForEach-Object { Copy-Item $_.FullName (Join-Path $Out "worker-$($_.Directory.Name).log") }
'done' | Set-Content (Join-Path $Out 'DONE')
