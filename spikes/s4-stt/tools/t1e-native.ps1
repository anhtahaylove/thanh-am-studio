# S4 T1e native: the recorded encode inputs of the T1e items (mode w) through Rust (s4-encode) and the Python wheel, each pinned to
# one core type (finding F-S4-1: the engine's numbers follow the core type at model load). Runs: python-P, rust-P, rust-E, python-E.
# usage: t1e-native.ps1 -Evidence <work\rm\s4-stt> -Exe <s4-encode.exe> [-Models small,turbo] [-Runs python-P,rust-P,rust-E,python-E]
param([Parameter(Mandatory)][string]$Evidence, [Parameter(Mandatory)][string]$Exe, [string[]]$Models = @('small', 'turbo'),
      [string[]]$Runs = @('python-P', 'rust-P', 'rust-E', 'python-E'))
$ErrorActionPreference = 'Stop'
(Get-Process -Id $PID).PriorityClass = 'BelowNormal'
$Py = 'C:\Users\User\Documents\Codex\2026-11-10\c-program-files-j2team-tts-j2team-2\work\rm\baseline-1.0.16\runtime\python\python.exe'
$T1e = Join-Path $PSScriptRoot 't1e.py'
$ModelRoot = 'C:\Users\User\Documents\Codex\2026-11-10\c-program-files-j2team-tts-j2team-2\work\rm\baseline-1.0.16\models'
$masks = @{ P = '0FFF'; E = 'F000' }   # i5-13400F: LP 0-11 P-cores (EfficiencyClass 1), LP 12-15 E-cores (0)
foreach ($n in 'MKL_ENABLE_INSTRUCTIONS', 'CT2_FORCE_CPU_ISA', 'ONEDNN_MAX_CPU_ISA', 'MKL_CBWR', 'CT2_USE_MKL', 'CT2_VERBOSE') { Remove-Item "Env:$n" -ErrorAction SilentlyContinue }
foreach ($model in $Models) {
    $md = Join-Path $ModelRoot "whisper-$model"
    foreach ($run in $Runs) {
        $who, $core = $run -split '-'
        $dir = Join-Path $Evidence "t1e\native\$model\$run"
        New-Item -ItemType Directory -Force $dir | Out-Null
        $list = Join-Path $dir 'list.tsv'
        & $Py -I $T1e list (Join-Path $Evidence 'rec') $model $dir $list | Out-Null
        $cmd = if ($who -eq 'rust') { "$Exe $md 8 $list" } else { "$Py -I $T1e pyencode $md 8 $list" }
        $t = Get-Date
        cmd.exe /c "start `"`" /b /wait /belownormal /affinity $($masks[$core]) $cmd > $dir\run.jsonl 2> $dir\run.err.log"
        "{0} {1} exit={2} seconds={3}" -f $model, $run, $LASTEXITCODE, [int]((Get-Date) - $t).TotalSeconds
    }
}
