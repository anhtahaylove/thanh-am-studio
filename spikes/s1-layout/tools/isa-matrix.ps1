# Runs the Whisper-small encode under each ISA setting and stores the raw encoder output + the engine/ISA evidence.
# usage: isa-matrix.ps1 -Tag host|sandbox -OutDir <dir> -ModelDir <whisper dir> [-WorkerExe <exe>] [-Python <python.exe> -PyScript <py_encode.py>]
param([Parameter(Mandatory)][string]$Tag, [Parameter(Mandatory)][string]$OutDir, [Parameter(Mandatory)][string]$ModelDir,
      [string]$WorkerExe, [string]$Python, [string]$PyScript, [int]$Threads = 8)
$ErrorActionPreference = 'Continue'  # PowerShell 5.1 turns native stderr (CT2 logs) into errors under Stop
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
# SDE is not available (Intel download needs an interactive licence acceptance), so `-snb` is approximated at the library-dispatch level.
$settings = [ordered]@{
    'native'      = @{}
    'mkl-avx'     = @{ MKL_ENABLE_INSTRUCTIONS = 'AVX' }
    'snb-dispatch' = @{ MKL_ENABLE_INSTRUCTIONS = 'AVX'; CT2_FORCE_CPU_ISA = 'AVX'; ONEDNN_MAX_CPU_ISA = 'AVX' }
}
$names = 'MKL_ENABLE_INSTRUCTIONS', 'CT2_FORCE_CPU_ISA', 'ONEDNN_MAX_CPU_ISA', 'MKL_VERBOSE', 'CT2_VERBOSE'
$summary = @()
foreach ($s in $settings.Keys) {
    foreach ($who in 'rust', 'python') {
        if ($who -eq 'rust' -and -not $WorkerExe) { continue }
        if ($who -eq 'python' -and -not $Python) { continue }
        foreach ($n in $names) { Remove-Item "Env:$n" -ErrorAction SilentlyContinue }
        foreach ($k in $settings[$s].Keys) { Set-Item "Env:$k" $settings[$s][$k] }
        $env:CT2_VERBOSE = '1'
        $bin = Join-Path $OutDir "$who-$Tag-$s.bin"
        $t = Get-Date
        $o = if ($who -eq 'rust') { & $WorkerExe health --skip ort,g2p --whisper $ModelDir --encode-out $bin --threads $Threads 2>&1 }
             else { & $Python -I $PyScript $ModelDir $bin $Threads int8 2>&1 }
        $code = $LASTEXITCODE
        $o | Out-File (Join-Path $OutDir "$who-$Tag-$s.log") -Encoding utf8
        $json = ($o | Where-Object { $_ -match '"encoder_sha256"' } | Select-Object -First 1)
        $isa = ($o | Where-Object { $_ -match 'Selected ISA|Use Intel MKL|SGEMM backend' }) -join ' | '
        $summary += [pscustomobject]@{ setting = $s; who = $who; exit = $code; seconds = [int]((Get-Date) - $t).TotalSeconds; isa = $isa; json = $json }
        # MKL's own ISA line (one extra run per setting, Rust only, verbose output discarded except its header)
        if ($who -eq 'rust') {
            $env:MKL_VERBOSE = '1'
            $all = & $WorkerExe health --skip ort,g2p --whisper $ModelDir --threads $Threads 2>&1
            $v = $all | Where-Object { $_ -match 'MKL_VERBOSE Intel' } | Select-Object -First 1
            $v | Out-File (Join-Path $OutDir "rust-$Tag-$s.mklverbose.txt") -Encoding utf8
        }
    }
}
$summary | ConvertTo-Json -Depth 3 | Out-File (Join-Path $OutDir "summary-$Tag.json") -Encoding utf8
$summary | Format-Table setting, who, exit, seconds -AutoSize | Out-String
