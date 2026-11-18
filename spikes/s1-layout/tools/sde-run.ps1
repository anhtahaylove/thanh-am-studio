# Runs the Whisper-small encode (Rust worker and Python wheel) under Intel SDE for each chip, e.g. -Chips snb,hsw.
# SDE emulates the chip's CPUID and faults on any instruction the chip lacks, so a finished run proves no newer instruction was executed.
# usage: sde-run.ps1 -Sde <sde.exe> -OutDir <dir> -ModelDir <whisper dir> -WorkerExe <exe> -Python <python.exe> -PyScript <py_encode.py> [-Chips snb,hsw] [-Threads 8]
param([Parameter(Mandatory)][string]$Sde, [Parameter(Mandatory)][string]$OutDir, [Parameter(Mandatory)][string]$ModelDir,
      [Parameter(Mandatory)][string]$WorkerExe, [Parameter(Mandatory)][string]$Python, [Parameter(Mandatory)][string]$PyScript,
      [string[]]$Chips = @('snb', 'hsw'), [int]$Threads = 8)
$ErrorActionPreference = 'Continue'
(Get-Process -Id $PID).PriorityClass = 'BelowNormal'   # children inherit it
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
foreach ($n in 'MKL_ENABLE_INSTRUCTIONS', 'CT2_FORCE_CPU_ISA', 'ONEDNN_MAX_CPU_ISA', 'MKL_VERBOSE', 'CT2_USE_MKL') { Remove-Item "Env:$n" -ErrorAction SilentlyContinue }
$env:CT2_VERBOSE = '1'
$rows = foreach ($chip in $Chips) {
    foreach ($who in 'rust', 'python') {
        $bin = Join-Path $OutDir "$who-sde-$chip.bin"
        Remove-Item $bin -ErrorAction SilentlyContinue
        $t = Get-Date
        $o = if ($who -eq 'rust') { & $Sde "-$chip" -- $WorkerExe health --skip ort,g2p --whisper $ModelDir --encode-out $bin --threads $Threads 2>&1 }
             else { & $Sde "-$chip" -- $Python -I $PyScript $ModelDir $bin $Threads int8 2>&1 }
        $code = $LASTEXITCODE
        $o | Out-File (Join-Path $OutDir "$who-sde-$chip.log") -Encoding utf8
        [pscustomobject]@{ chip = $chip; who = $who; exit = $code; seconds = [int]((Get-Date) - $t).TotalSeconds; bin = (Test-Path $bin) }
    }
}
$rows | Format-Table -AutoSize | Out-String
