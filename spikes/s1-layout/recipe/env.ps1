# Shared settings for the S1 engine recipe. Dot-source it.
$ErrorActionPreference = 'Stop'
$script:Evidence = 'C:\Users\User\Documents\Codex\2026-11-10\c-program-files-j2team-tts-j2team-2\work\rm\s1-layout'
$script:Inputs   = Join-Path $Evidence 'inputs'
# Short build root: oneDNN's object paths overflow MAX_PATH under the evidence root.
$script:Root     = 'C:\s1b'
$script:Lib      = Join-Path $Root 'lib'          # the recipe's lib directory (LIBRARY_PATH for ct2rs-sys)
$script:Vcvars   = 'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat'
$script:RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
New-Item -ItemType Directory -Force -Path $Root, $Lib | Out-Null
# Import the MSVC x64 environment (cmd's `set` after vcvars) into this process.
cmd /c "`"$Vcvars`" >nul && set" | ForEach-Object { if ($_ -match '^([^=]+)=(.*)$' -and $Matches[1] -ne 'PSModulePath') { Set-Item -Path "Env:$($Matches[1])" -Value $Matches[2] } }
$env:VSLANG = '1033'
# Never disturb other agents' CPU measurements.
(Get-Process -Id $PID).PriorityClass = 'BelowNormal'
