# Import library for thanham-diarize generated from the wheel's sherpa-onnx-c-api.dll exports (plan §3, diarize bullet).
param([string]$Dll = 'C:\Users\User\Documents\Codex\2026-11-10\c-program-files-j2team-tts-j2team-2\work\rm\baseline-1.0.16\runtime\python\Lib\site-packages\sherpa_onnx\lib\sherpa-onnx-c-api.dll')
. $PSScriptRoot\env.ps1
$out = Join-Path $Root 'sherpa'
New-Item -ItemType Directory -Force -Path $out | Out-Null
$names = foreach ($l in & dumpbin /nologo /exports $Dll) { if ($l -match '^\s+\d+\s+[0-9A-F]+\s+[0-9A-F]{8}\s+(\S+)') { $Matches[1] } }
Set-Content -LiteralPath "$out\sherpa-onnx-c-api.def" -Encoding ascii -Value (@('LIBRARY sherpa-onnx-c-api', 'EXPORTS') + $names)
lib /nologo /def:"$out\sherpa-onnx-c-api.def" /machine:x64 /out:"$out\sherpa-onnx-c-api.lib" | Out-Null
"sherpa import lib: $($names.Count) exports"
