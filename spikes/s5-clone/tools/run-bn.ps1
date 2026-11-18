# Run a command at BelowNormal priority, mirroring stdout/stderr to a log file. Usage:
#   run-bn.ps1 -Log <log> -Exe <exe> -ArgList <arg0>, <arg1>, ...
param([Parameter(Mandatory)][string]$Log, [Parameter(Mandatory)][string]$Exe, [string[]]$ArgList = @())
$ErrorActionPreference = 'Stop'
$psi = [System.Diagnostics.ProcessStartInfo]::new($Exe)
foreach ($a in $ArgList) { $psi.ArgumentList.Add($a) }
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.UseShellExecute = $false
$psi.WorkingDirectory = (Get-Location).Path
$p = [System.Diagnostics.Process]::Start($psi)
try { $p.PriorityClass = [System.Diagnostics.ProcessPriorityClass]::BelowNormal } catch {}
$out = $p.StandardOutput.ReadToEndAsync()
$err = $p.StandardError.ReadToEndAsync()
$p.WaitForExit()
Set-Content -LiteralPath $Log -Value ($out.Result + "`n--- stderr ---`n" + $err.Result) -Encoding utf8
"exit $($p.ExitCode)"
exit $p.ExitCode
