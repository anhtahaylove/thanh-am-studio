# Runs INSIDE a throwaway Windows Sandbox (it changes the machine certificate store and the user proxy settings).
# usage: probe-reqwest.ps1 <dir containing reqwest-probe.exe>
param([Parameter(Mandatory)][string]$Dir)
$ErrorActionPreference = 'Stop'
$exe = Join-Path $Dir 'reqwest-probe.exe'
$out = @()
function Probe([string]$name, [string[]]$a) {
    $o = & $exe @a 2>&1 | Out-String
    $script:out += "{`"case`":`"$name`",`"exit`":$LASTEXITCODE,`"result`":$($o.Trim())}"
}
# A root CA and a localhost leaf signed by it.
$ca = New-SelfSignedCertificate -Subject 'CN=S1 Probe Root CA' -KeyUsage CertSign, CRLSign -TextExtension @('2.5.29.19={critical}{text}ca=1') -CertStoreLocation Cert:\CurrentUser\My -NotAfter (Get-Date).AddDays(2)
$leaf = New-SelfSignedCertificate -Subject 'CN=localhost' -DnsName 'localhost' -Signer $ca -CertStoreLocation Cert:\LocalMachine\My -NotAfter (Get-Date).AddDays(2)
$pem = "-----BEGIN CERTIFICATE-----`n" + [Convert]::ToBase64String($ca.RawData, 'InsertLineBreaks') + "`n-----END CERTIFICATE-----`n"
$caPem = Join-Path $Dir 's1-root-ca.pem'
[IO.File]::WriteAllText($caPem, $pem)
netsh http add sslcert ipport=127.0.0.1:8443 certhash=$($leaf.Thumbprint) appid='{00112233-4455-6677-8899-aabbccddeeff}' | Out-Null
$serve = {
    param($prefix, $mode)
    $l = New-Object System.Net.HttpListener
    $l.Prefixes.Add($prefix); $l.Start()
    while ($true) {
        $c = $l.GetContext()
        $text = if ($mode -eq 'proxy') { "via-proxy:" + $c.Request.RawUrl } else { 'hello-tls' }
        $b = [Text.Encoding]::UTF8.GetBytes($text)
        $c.Response.OutputStream.Write($b, 0, $b.Length); $c.Response.Close()
    }
}
$j1 = Start-Job $serve -ArgumentList 'https://localhost:8443/', 'tls'
$j2 = Start-Job $serve -ArgumentList 'http://+:8899/', 'proxy'
Start-Sleep 4
Probe 'tls-no-ca-not-in-store (negative control)' @('https://localhost:8443/')
Probe 'tls-custom-root-ca-merge (--ca)' @('https://localhost:8443/', '--ca', $caPem)
Probe 'tls-custom-root-ca-only (--ca --only)' @('https://localhost:8443/', '--ca', $caPem, '--only')
# The CA in the machine store: the platform verifier (like Python's truststore, F22) must now trust it with no flags.
$cer = Join-Path $Dir 's1-root-ca.cer'
Export-Certificate -Cert $ca -FilePath $cer | Out-Null
Import-Certificate -FilePath $cer -CertStoreLocation Cert:\LocalMachine\Root | Out-Null
Probe 'tls-ca-in-os-store (platform verifier, no flags)' @('https://localhost:8443/')
# System proxy: a plain-HTTP "proxy" answers for a host that exists nowhere else; reqwest must pick it up from the user's settings.
$k = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
Set-ItemProperty $k ProxyEnable 1; Set-ItemProperty $k ProxyServer '127.0.0.1:8899'; Set-ItemProperty $k ProxyOverride ''
Probe 'http-system-proxy (registry ProxyServer)' @('http://s1-probe.invalid/path')
Probe 'http-no-proxy (negative control)' @('http://s1-probe.invalid/path', '--no-proxy')
Set-ItemProperty $k ProxyEnable 0
$env:HTTP_PROXY = 'http://127.0.0.1:8899'
Probe 'http-env-proxy (HTTP_PROXY, registry proxy off)' @('http://s1-probe.invalid/env')
Remove-Item Env:\HTTP_PROXY
Stop-Job $j1, $j2 -ErrorAction SilentlyContinue
$out -join "`n"
