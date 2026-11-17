# Empty cublas.lib / cublasLt.lib (plan §3 step 7): ct2rs-sys 0.11.2 `system` asks for static=cublas / static=cublasLt on Windows even without CUDA (F42).
. $PSScriptRoot\env.ps1
$w = Join-Path $Root 'stubs'
New-Item -ItemType Directory -Force -Path $w | Out-Null
Set-Content -LiteralPath (Join-Path $w 'empty.c') -Value '/* intentionally empty: no symbols */' -Encoding ascii
Push-Location $w
cl /nologo /c /MT empty.c /Fo:empty.obj | Out-Null
foreach ($n in 'cublas', 'cublasLt') {
    lib /nologo /OUT:"$Lib\$n.lib" empty.obj | Out-Null
    # The assertion: no public symbols, so any real CUDA reference fails to link instead of resolving silently.
    $m = & dumpbin /nologo /linkermember:1 "$Lib\$n.lib" | Out-String
    $m | Set-Content -LiteralPath (Join-Path $Evidence "stub-$n-linkermember.txt")
    if ($m -notmatch '\b0 public symbols') { throw "$n.lib exports symbols:`n$m" }
    "$n.lib: 0 public symbols (asserted)"
}
Pop-Location
