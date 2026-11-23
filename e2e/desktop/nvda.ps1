# NVDA for the packaged nvda phase (packaged.mjs). Inside Windows Sandbox only, never on a host: NVDA is downloaded there from
# NV Access, checked (SHA-256 and Authenticode signer), unpacked as a portable copy and started with the silent synth and IO
# logging, so its log records every sequence it would speak.
#   -Install [-Out C:\out]          download into C:\nvdadl, verify, create C:\nvda, write its nvda.ini (copied to <Out>\nvda-config.ini)
#   -Start [-Out C:\out]            start NVDA (minimal, no add-ons, IO log in <Out>\nvda.log) and wait for "NVDA initialized"
#   -Focus -Pid <pid>               bring that process's main window to the foreground and check that it is there
#   -Keys <sendkeys> -Pid <pid>     -Focus, then SendKeys: OS-level input that both NVDA and WebView2's host see
#   -Windows -Pid <pid>             JSON list of the visible top-level and popup windows of that process tree
#   -Stop                           nvda.exe -q, then end what is left of NVDA after 10 s
# Options and nvda.ini keys checked against NVDA's source at tag release-2026.3.1 (source/argsParsing.py, config/configSpec.py,
# core.py "NVDA initialized", speech/speech.py `log.io("Speaking %r")`, logHandler IO = 12, synthDrivers/silence.py).
param([switch]$Install, [switch]$Start, [switch]$Focus, [string]$Keys = '', [switch]$Windows, [switch]$Stop,
    [Alias('Pid')][int]$AppPid = 0, [string]$Out = 'C:\out')
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue' # Windows PowerShell's progress bar slows Invoke-WebRequest down a lot
$Version = '2026.3.1'
$Url = "https://download.nvaccess.org/releases/$Version/nvda_$Version.exe"
$Sha256 = '6f80a5b0ca720a7d0d314b5be212f37388bbe81a1107ac3298c1821a1cd3f052' # from the release-2026.3.1 notes
$Signer = 'NV Access'
$Portable = 'C:\nvda'

Add-Type @'
using System; using System.Collections.Generic; using System.Runtime.InteropServices; using System.Text;
public static class Nv {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct R { public int L, T, Rt, B; }
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out R r);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  static string Cls(IntPtr h) { var s = new StringBuilder(256); GetClassName(h, s, 256); return s.ToString(); }
  static string Title(IntPtr h) { var s = new StringBuilder(512); GetWindowText(h, s, 512); return s.ToString(); }
  public static uint PidOf(IntPtr h) { uint p; GetWindowThreadProcessId(h, out p); return p; }
  // The process's visible, unowned top-level window with a title (the app's main window).
  public static IntPtr MainWindow(uint pid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => { if (PidOf(h) == pid && IsWindowVisible(h) && GetWindow(h, 4 /*GW_OWNER*/) == IntPtr.Zero && Title(h).Length > 0) { found = h; return false; } return true; }, IntPtr.Zero);
    return found;
  }
  public static bool Activate(IntPtr h) {
    if (IsIconic(h)) ShowWindow(h, 9 /*SW_RESTORE*/);
    IntPtr fg = GetForegroundWindow();
    uint fgPid, fgThread = fg == IntPtr.Zero ? 0 : GetWindowThreadProcessId(fg, out fgPid), me = GetCurrentThreadId();
    // The foreground lock lets a process that does not own the foreground take it only while its input is attached.
    if (fgThread != 0 && fgThread != me) AttachThreadInput(me, fgThread, true);
    BringWindowToTop(h); SetForegroundWindow(h);
    if (fgThread != 0 && fgThread != me) AttachThreadInput(me, fgThread, false);
    return GetForegroundWindow() == h;
  }
  public static List<string[]> List(HashSet<uint> pids) {
    var rows = new List<string[]>();
    EnumWindows((h, l) => {
      uint p = PidOf(h);
      if (pids.Contains(p) && IsWindowVisible(h)) {
        R r; GetWindowRect(h, out r);
        bool popup = (GetWindowLong(h, -16 /*GWL_STYLE*/) & unchecked((int)0x80000000) /*WS_POPUP*/) != 0;
        rows.Add(new[] { h.ToInt64().ToString(), p.ToString(), Cls(h), Title(h), r.L + "," + r.T + "," + r.Rt + "," + r.B, popup ? "popup" : "top" });
      }
      return true;
    }, IntPtr.Zero);
    return rows;
  }
}
'@

function Wait-Until([scriptblock]$Test, [int]$Seconds) {
    $end = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $end) { if (& $Test) { return $true }; Start-Sleep -Milliseconds 250 }
    return [bool](& $Test)
}
function Read-Shared($Path) {
    $s = [IO.File]::Open($Path, 'Open', 'Read', 'ReadWrite, Delete')
    try { (New-Object IO.StreamReader($s)).ReadToEnd() } finally { $s.Dispose() }
}
function Invoke-Focus {
    if (-not $AppPid) { throw 'ABORT nvda-focus: -Pid is required' }
    $h = [Nv]::MainWindow([uint32]$AppPid)
    if ($h -eq [IntPtr]::Zero) { throw "ABORT nvda-focus: process $AppPid has no visible main window" }
    if ([Nv]::GetForegroundWindow() -ne $h) {
        try { $null = (New-Object -ComObject WScript.Shell).AppActivate([int]$AppPid) } catch {}
        $null = Wait-Until { [Nv]::GetForegroundWindow() -eq $h -or [Nv]::Activate($h) } 3
    }
    $fg = [Nv]::GetForegroundWindow()
    if ([Nv]::PidOf($fg) -ne [uint32]$AppPid) { throw "ABORT nvda-focus: the foreground window $fg belongs to process $([Nv]::PidOf($fg)), not $AppPid" }
    "foreground $h"
}

# Installing or starting a screen reader changes the machine: only in Windows Sandbox, whose user is WDAGUtilityAccount.
if (($Install -or $Start) -and $env:USERNAME -ne 'WDAGUtilityAccount') { throw 'ABORT nvda-setup: Windows Sandbox only' }
if ($Install) {
    $dl = 'C:\nvdadl'
    New-Item -ItemType Directory -Path $dl -Force | Out-Null
    $exe = Join-Path $dl "nvda_$Version.exe"
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $Url -OutFile $exe -UseBasicParsing
    $hash = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant()
    $sig = Get-AuthenticodeSignature -LiteralPath $exe
    $subject = "$($sig.SignerCertificate.Subject)"
    if ($hash -ne $Sha256 -or $sig.Status -ne 'Valid' -or $subject -notlike "*$Signer*") { throw "ABORT nvda-setup: sha256 $hash (want $Sha256), signature $($sig.Status) by '$subject'" }
    $p = Start-Process -FilePath $exe -ArgumentList '--create-portable-silent', "--portable-path=$Portable" -Wait -PassThru
    # The launcher unpacks itself and runs the copy step in its own nvda.exe; wait for that one too.
    $null = Wait-Until { -not (Get-Process nvda -ErrorAction SilentlyContinue) } 120
    if (-not (Test-Path -LiteralPath (Join-Path $Portable 'nvda.exe'))) { throw "ABORT nvda-setup: no portable copy in $Portable (launcher exit $($p.ExitCode))" }
    $config = Join-Path $Portable 'userConfig'
    New-Item -ItemType Directory -Path $config -Force | Out-Null
    # English UI, the silent synth (speech is still logged), no welcome dialog, no update check, usage stats answered "no",
    # and browse mode off when a page loads (no browse-mode tree interceptor, so keys go straight to the page).
    @(
        'schemaVersion = 25', '[general]', "`tlanguage = en", "`tshowWelcomeDialogAtStartup = False", "`tplayStartAndExitSounds = False", "`taskToExit = False",
        '[update]', "`tautoCheck = False", "`tstartupNotification = False", "`taskedAllowUsageStats = True", "`tallowUsageStats = False",
        '[speech]', "`tsynth = silence", '[virtualBuffers]', "`tenableOnPageLoad = False"
    ) | Set-Content -LiteralPath (Join-Path $config 'nvda.ini') -Encoding ascii
    Copy-Item -LiteralPath (Join-Path $config 'nvda.ini') -Destination (Join-Path $Out 'nvda-config.ini') -Force
    "NVDA $Version portable copy in $Portable; sha256 ok; signed by '$subject'"
} elseif ($Start) {
    $log = Join-Path $Out 'nvda.log'
    Start-Process -FilePath (Join-Path $Portable 'nvda.exe') -ArgumentList '-m', '--disable-addons', '--log-level=12', "--log-file=$log" | Out-Null
    # NVDA keeps the log open for writing, so read it with a share mode that allows that.
    $ready = Wait-Until { (Test-Path -LiteralPath $log) -and (Read-Shared $log) -match '(?m)^NVDA initialized' } 60
    if (-not $ready) { throw "ABORT nvda-start: no 'NVDA initialized' in $log within 60 s" }
    "NVDA initialized; log $log"
} elseif ($Focus) {
    Invoke-Focus
} elseif ($Keys) {
    $f = Invoke-Focus
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.SendKeys]::SendWait($Keys)
    "$f; sent $Keys"
} elseif ($Windows) {
    if (-not $AppPid) { throw '-Pid is required' }
    $all = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId)
    $tree = New-Object 'System.Collections.Generic.HashSet[uint32]'
    $null = $tree.Add([uint32]$AppPid)
    do { $grew = $false; foreach ($p in $all) { if ($tree.Contains([uint32]$p.ParentProcessId) -and $tree.Add([uint32]$p.ProcessId)) { $grew = $true } } } while ($grew)
    $rows = @([Nv]::List($tree) | ForEach-Object { [ordered]@{ handle = $_[0]; pid = [int]$_[1]; class = $_[2]; title = $_[3]; rect = $_[4]; kind = $_[5] } })
    ConvertTo-Json -InputObject $rows -Compress -Depth 3
} elseif ($Stop) {
    $exe = Join-Path $Portable 'nvda.exe'
    if (Test-Path -LiteralPath $exe) { Start-Process -FilePath $exe -ArgumentList '-q' | Out-Null }
    $mine = { @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($Portable, [StringComparison]::OrdinalIgnoreCase) }) }
    if (-not (Wait-Until { (& $mine).Count -eq 0 } 10)) { & $mine | Stop-Process -Force -ErrorAction SilentlyContinue; 'NVDA ended by force' } else { 'NVDA quit' }
} else {
    throw 'usage: nvda.ps1 -Install | -Start | -Focus -Pid <pid> | -Keys <sendkeys> -Pid <pid> | -Windows -Pid <pid> | -Stop [-Out <dir>]'
}
