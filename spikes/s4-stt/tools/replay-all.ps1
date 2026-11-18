# S4 T1a: replays every recorded job (rec\<corpus>\<model>\<mode>\events.jsonl) through the Rust glue and prints one summary line each.
# usage: replay-all.ps1 -Evidence <work\rm\s4-stt> -Exe <s4-replay.exe>
param([Parameter(Mandatory)][string]$Evidence, [Parameter(Mandatory)][string]$Exe)
$ErrorActionPreference = 'Stop'
(Get-Process -Id $PID).PriorityClass = 'BelowNormal'
$ModelRoot = 'C:\Users\User\Documents\Codex\2026-11-10\c-program-files-j2team-tts-j2team-2\work\rm\baseline-1.0.16\models'
New-Item -ItemType Directory -Force (Join-Path $Evidence 't1a') | Out-Null
foreach ($f in Get-ChildItem (Join-Path $Evidence 'rec') -Recurse -Filter events.jsonl | Sort-Object FullName) {
    $mode = $f.Directory.Name; $model = $f.Directory.Parent.Name; $corpus = $f.Directory.Parent.Parent.Name
    $tag = "$corpus-$model-$mode"
    & $Exe (Join-Path $Evidence 'rec') $corpus $model $mode (Join-Path $ModelRoot "whisper-$model") --out (Join-Path $Evidence "t1a\$tag.rust.jsonl") > (Join-Path $Evidence "t1a\$tag.replay.jsonl")
    "$tag exit=$LASTEXITCODE " + (Get-Content (Join-Path $Evidence "t1a\$tag.replay.jsonl") -Tail 1)
}
