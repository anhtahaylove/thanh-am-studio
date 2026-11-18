# Runs inside Windows Sandbox: clean Windows, no Python/FFmpeg, repo and installer mapped read-only.
# -Only runs the listed packaged.mjs phases (network on); -Gate N runs the N-segment gate instead.
# -From (an earlier installer, or a folder holding one) installs that first, so the update phase updates it to the installer
# under test as users get it; keep it out of the top of the installer folder, for example in C:\installer\from\. It needs
# -Only update, or -Only update,update-seeded: any other phase would test the earlier release.
# -Seed (a folder holding some of vieneu-v3, whisper-small, diarization and htdemucs, mapped into the Sandbox, for example as C:\seed)
# copies those model folders into the data folder before the first install, as a user who already has the models would have
# them; the update-seeded phase then checks that they are used as they are.
param([string]$Repo = 'C:\repo', [string]$Installer = 'C:\installer', [string]$Out = 'C:\out', [string]$Only = '', [int]$Gate = 0, [string]$From = '', [string]$Seed = '')
$ErrorActionPreference = 'Continue'
$log = Join-Path $Out 'sandbox.log'
function Log($m) { "$(Get-Date -Format o) $m" | Tee-Object -FilePath $log -Append }
Log "user=$env:USERNAME os=$([Environment]::OSVersion.VersionString) cpu=$((Get-CimInstance Win32_Processor).Name) ram=$([math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory/1GB,1))GB"
foreach ($c in 'python', 'python3', 'py', 'ffmpeg', 'ffprobe', 'uv') { Log "PATH $c => $((Get-Command $c -ErrorAction SilentlyContinue).Source)" }
$setup = Get-ChildItem -LiteralPath $Installer -Filter '*-setup.exe' | Select-Object -First 1
$first = if ($From) { Get-ChildItem -Path $From -Filter '*-setup.exe' -ErrorAction SilentlyContinue | Select-Object -First 1 } else { $setup }
$updateOnly = $Only -and -not (($Only -split ',') | Where-Object { $_ -notin 'update', 'update-seeded' })
if (-not $setup -or -not $first -or ($From -and -not $updateOnly) -or ('update-seeded' -in ($Only -split ',') -and -not $Seed)) {
    Log "not run: installer=$($setup.Name) from=$($first.Name) (-From $From) -Only $Only -Seed $Seed; -From needs an installer and only the update and update-seeded phases, and update-seeded needs -Seed"
    'done' | Set-Content (Join-Path $Out 'DONE'); exit 1
}
$env:THANHAM_UPDATE_FROM = $From
$env:THANHAM_SEED = $Seed
if ($Seed) {
    $models = Join-Path $env:LOCALAPPDATA 'studio.thanham.desktop\models'
    New-Item -ItemType Directory -Path $models -Force | Out-Null
    foreach ($id in 'vieneu-v3', 'whisper-small', 'diarization', 'htdemucs') {
        if (Test-Path -LiteralPath (Join-Path $Seed $id)) { Copy-Item -LiteralPath (Join-Path $Seed $id) -Destination $models -Recurse -Force; Log "seeded $id" }
    }
}
$t = Get-Date
$p = Start-Process -FilePath $first.FullName -ArgumentList '/S' -Wait -PassThru
Log "install $($first.Name) exit=$($p.ExitCode) seconds=$([math]::Round(((Get-Date)-$t).TotalSeconds))"
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
$env:THANHAM_DOCX = Join-Path $Installer 'script.docx' # optional input of the scripts phase (a Word file saved by Word)
$env:THANHAM_UPDATE_FEED = Join-Path $Installer 'latest.json' # input of the update phase (the release's update feed)
$env:THANHAM_UPDATE_SETUP = $setup.FullName
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
