# S4 T1e SDE subset (THRESHOLDS-S4.md): the first recorded encode of mix-0000 (mode w) per model, under Intel SDE -snb and -skx,
# Rust (s4-encode) and the Python wheel (t1e.py pyencode), both at BelowNormal and pinned to the P-cores (finding F-S4-1).
# usage: sde-t1e.ps1 -Evidence <work\rm\s4-stt> -Exe <s4-encode.exe> [-Models small,turbo] [-Chips snb,skx] [-Mask 0FFF]
param([Parameter(Mandatory)][string]$Evidence, [Parameter(Mandatory)][string]$Exe,
      [string[]]$Models = @('small', 'turbo'), [string[]]$Chips = @('snb', 'skx'), [string]$Mask = '0FFF')
$ErrorActionPreference = 'Stop'
(Get-Process -Id $PID).PriorityClass = 'BelowNormal'
$Sde = 'C:\Users\User\Documents\Codex\2026-11-10\c-program-files-j2team-tts-j2team-2\work\rm\s1-layout\inputs\sde\sde-external-10.13.1-2026-07-28-win\sde.exe'
$Py = 'C:\Users\User\Documents\Codex\2026-11-10\c-program-files-j2team-tts-j2team-2\work\rm\baseline-1.0.16\runtime\python\python.exe'
$T1e = Join-Path $PSScriptRoot 't1e.py'
$ModelRoot = 'C:\Users\User\Documents\Codex\2026-11-10\c-program-files-j2team-tts-j2team-2\work\rm\baseline-1.0.16\models'
foreach ($n in 'MKL_ENABLE_INSTRUCTIONS', 'CT2_FORCE_CPU_ISA', 'ONEDNN_MAX_CPU_ISA', 'MKL_CBWR', 'CT2_USE_MKL') { Remove-Item "Env:$n" -ErrorAction SilentlyContinue }
$env:CT2_VERBOSE = '1'
foreach ($model in $Models) {
    foreach ($chip in $Chips) {
        foreach ($who in 'rust', 'python') {
            $dir = Join-Path $Evidence "t1e\sde\$model\$chip\$who"
            New-Item -ItemType Directory -Force $dir | Out-Null
            $list = Join-Path $dir 'list.tsv'
            & $Py -I $T1e list (Join-Path $Evidence 'rec') $model $dir $list first | Out-Null
            $log = Join-Path $dir 'run.log'
            $md = Join-Path $ModelRoot "whisper-$model"
            $cmd = if ($who -eq 'rust') { "$Exe $md 8 $list" } else { "$Py -I $T1e pyencode $md 8 $list" }
            while ((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory -lt 3MB) { "waiting for 3 GB of free RAM"; Start-Sleep 60 }  # shared machine rule (KB)
            $t = Get-Date
            cmd.exe /c "start `"`" /b /wait /belownormal /affinity $Mask $Sde -$chip -- $cmd > $log 2>&1"
            "{0} {1} {2} exit={3} seconds={4}" -f $model, $chip, $who, $LASTEXITCODE, [int]((Get-Date) - $t).TotalSeconds
        }
    }
}
