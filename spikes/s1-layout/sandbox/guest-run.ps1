# Runs INSIDE the Windows Sandbox on a clean machine: only the shipped files (C:\apps\app) and read-only test data (C:\apps\data).
# usage: guest-run.ps1 [-App C:\apps\app] [-Data C:\apps\data] [-Out C:\out] [-Tools C:\apps\tools]
param([string]$App = 'C:\apps\app', [string]$Data = 'C:\apps\data', [string]$Out = 'C:\out', [string]$Tools = 'C:\apps\tools')
$ErrorActionPreference = 'Continue'
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$worker = Join-Path $App 'worker\thanham-worker.exe'
$diar = Join-Path $App 'worker\native\sherpa\thanham-diarize.exe'
# What the "clean machine" lacks: the VC++ redistributable and the MSVC OpenMP runtime must not be in System32.
$sys = foreach ($f in 'vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll', 'msvcp140_1.dll', 'vcomp140.dll', 'libomp.dll', 'libiomp5md.dll', 'onnxruntime.dll') {
    '{0,-20} in System32: {1}' -f $f, (Test-Path "C:\Windows\System32\$f")
}
$info = @("computer: $env:COMPUTERNAME", "os: $((Get-CimInstance Win32_OperatingSystem).Caption) $((Get-CimInstance Win32_OperatingSystem).BuildNumber)",
          "cpu: $((Get-CimInstance Win32_Processor | Select-Object -First 1).Name)", "cores: $env:NUMBER_OF_PROCESSORS", '', 'redistributables:') + $sys
$info | Out-File (Join-Path $Out 'machine.txt') -Encoding utf8
Set-Location C:\   # not the exe folder: DLLs must resolve next to the exe, not from the cwd
foreach ($n in 'MKL_ENABLE_INSTRUCTIONS', 'CT2_FORCE_CPU_ISA', 'ONEDNN_MAX_CPU_ISA', 'MKL_VERBOSE', 'CT2_VERBOSE', 'CT2_USE_MKL') { Remove-Item "Env:$n" -ErrorAction SilentlyContinue }
$env:CT2_VERBOSE = '1'
$o = & $worker health --whisper "$Data\whisper-small" --silero "$Data\vad\silero_vad_v6.onnx" --g2p-bin "$Data\g2p\sea_g2p.bin" --tokenizer "$Data\g2p\vieneu-tokenizer.json" --encode-out (Join-Path $Out 'rust-sandbox-health.bin') --threads 8 2>&1
"exit=$LASTEXITCODE" | Out-File (Join-Path $Out 'health-exit.txt')
$o | Out-File (Join-Path $Out 'health.log') -Encoding utf8
Remove-Item Env:CT2_VERBOSE
$d1 = & $diar 2>&1; "exit=$LASTEXITCODE" | Out-File (Join-Path $Out 'diarize-load-exit.txt'); $d1 | Out-File (Join-Path $Out 'diarize-load.log') -Encoding utf8
$d2 = & $diar "$Data\diarization" 2>&1; "exit=$LASTEXITCODE" | Out-File (Join-Path $Out 'diarize-exit.txt'); $d2 | Out-File (Join-Path $Out 'diarize.log') -Encoding utf8
& (Join-Path $Tools 'isa-matrix.ps1') -Tag sandbox -OutDir (Join-Path $Out 'isa') -ModelDir "$Data\whisper-small" -WorkerExe $worker | Out-File (Join-Path $Out 'isa-table.txt') -Encoding utf8
'done' | Out-File (Join-Path $Out 'DONE.txt')
