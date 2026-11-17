# Tiny servers for probe-reqwest.ps1.
#   tls   <port> <leaf thumbprint in LocalMachine\My> <log>   HTTPS (SslStream) answering "hello-tls"
#   proxy <port> none <log>                                    plain-HTTP "proxy" answering "via-proxy:<requested URL>"
param([string]$Mode, [int]$Port, [string]$Thumb, [string]$Log)
$ErrorActionPreference = 'Continue'
$l = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, $Port); $l.Start()
"started $Mode $Port" | Out-File $Log
if ($Mode -eq 'tls') { $cert = Get-Item "Cert:\LocalMachine\My\$Thumb" }
function ReadRequest($stream) {
    $buf = New-Object byte[] 4096; $sb = New-Object Text.StringBuilder
    while ($sb.ToString() -notmatch "`r`n`r`n") { $n = $stream.Read($buf, 0, $buf.Length); if ($n -le 0) { break }; [void]$sb.Append([Text.Encoding]::ASCII.GetString($buf, 0, $n)) }
    $sb.ToString()
}
function Reply($stream, $text) {
    $b = [Text.Encoding]::UTF8.GetBytes($text)
    $h = [Text.Encoding]::ASCII.GetBytes("HTTP/1.1 200 OK`r`nContent-Type: text/plain`r`nContent-Length: $($b.Length)`r`nConnection: close`r`n`r`n")
    $stream.Write($h, 0, $h.Length); $stream.Write($b, 0, $b.Length); $stream.Flush()
}
while ($true) {
    $c = $l.AcceptTcpClient()
    try {
        $stream = $c.GetStream()
        if ($Mode -eq 'tls') {
            $stream = New-Object Net.Security.SslStream($stream, $false)
            $stream.AuthenticateAsServer($cert, $false, ([Security.Authentication.SslProtocols]::Tls12 -bor [Security.Authentication.SslProtocols]::Tls13), $false)
            $req = ReadRequest $stream; Reply $stream 'hello-tls'; "served tls" | Out-File $Log -Append
        } else {
            $req = ReadRequest $stream; $url = ($req -split "`r`n")[0].Split(' ')[1]; Reply $stream "via-proxy:$url"; "served $url" | Out-File $Log -Append
        }
    } catch { "error $_" | Out-File $Log -Append } finally { $c.Close() }
}
