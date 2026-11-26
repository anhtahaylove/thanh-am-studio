<#
Model RAM probe (F1). Runs one model job the way the desktop runs it (src-tauri/src/runtime.rs, `prepare_request` and `attempt`)
and records the peak working set of the worker process tree, sampled every 250 ms. Windows PowerShell 5.1.

  powershell -NoProfile -File scripts\measure-model-ram.ps1 -App <extracted install folder> -Models <models folder> -Op stt `
    -Model whisper-small -Input dialogue.wav -Runs 3 -Out <folder> [-Diarize [-Speakers 2]] [-Engine native|python] `
    [-LockDir <folder of .f1-running and .perf-lock>] [-Wait] [-Until <time>]

Each run writes run-<n>.csv (one row per sample) and run-<n>.json (peaks, CPU, threads, validity); summary.json covers every run in
-Out. Run numbers continue after the runs already in -Out. A run is valid only when it started with at least 8,192 MB available and
8 GiB of commit headroom, available memory never fell below 4,096 MB, no Windows Sandbox ran, no live perf lock existed, and the
worker exited 0 after a `result` event. The worker and every child run at Normal priority with EcoQoS off and no core pinning.
#>
param(
    [Parameter(Mandatory = $true)][string]$App,
    [Parameter(Mandatory = $true)][string]$Models,
    [Parameter(Mandatory = $true)][ValidateSet('stt', 'separate')][string]$Op,
    [ValidateSet('whisper-small', 'whisper-turbo')][string]$Model = 'whisper-small',
    # Named -Input on the command line; $Input itself is an automatic variable.
    [Parameter(Mandatory = $true)][Alias('Input')][string]$InputPath,
    [switch]$Diarize,
    # 0: diarization counts the speakers itself.
    [ValidateRange(0, 8)][int]$Speakers = 0,
    [ValidateSet('', 'native', 'python')][string]$Engine = '',
    [ValidateRange(1, 20)][int]$Runs = 1,
    [Parameter(Mandatory = $true)][string]$Out,
    [string]$LockDir = '',
    [switch]$Wait,
    [datetime]$Until = [datetime]::MaxValue
)
$ErrorActionPreference = 'Stop'
$MinStartAvailMB = 8192; $MinStartHeadroomMB = 8192; $MinRunAvailMB = 4096; $IntervalMs = 250; $PollSeconds = 120

Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace F1Probe
{
    public class Member
    {
        public int Pid, ParentPid; public string Name; public long Created; public IntPtr Handle; public bool Owned;
        public long MaxWs, MaxPrivate, OsPeakWs, OsPeakCommit;
        public uint PriorityBefore, PriorityAfter; public bool EcoQosOff;
    }
    public class Outcome
    {
        public int ExitCode; public double WallS, CpuS; public int Samples, MaxThreads, MaxProcs; public bool JobAssigned;
        public long PeakTreeWs, PeakTreePrivate, JobPeakCommit, JobPeakProcessCommit;
        public long MinAvail = long.MaxValue, MinHeadroom = long.MaxValue;
        public List<string> Lines = new List<string>();
        public List<Member> Members = new List<Member>();
    }
    public static class Probe
    {
        const uint NORMAL = 0x20, STILL_ACTIVE = 259;
        [StructLayout(LayoutKind.Sequential)] struct BASIC { public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass, SchedulingClass; }
        [StructLayout(LayoutKind.Sequential)] struct IOC { public ulong A, B, C, D, E, F; }
        [StructLayout(LayoutKind.Sequential)] struct EXT { public BASIC Basic; public IOC Io; public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }
        [StructLayout(LayoutKind.Sequential)] struct ACCT { public long TotalUserTime, TotalKernelTime, ThisPeriodUser, ThisPeriodKernel; public uint PageFaults, TotalProcesses, ActiveProcesses, Terminated; }
        [StructLayout(LayoutKind.Sequential)] struct PMC { public uint cb, PageFaultCount; public UIntPtr PeakWorkingSetSize, WorkingSetSize, QPeakPaged, QPaged, QPeakNonPaged, QNonPaged, PagefileUsage, PeakPagefileUsage, PrivateUsage; }
        [StructLayout(LayoutKind.Sequential)] struct THROTTLE { public uint Version, ControlMask, StateMask; }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct PE32 { public uint dwSize, cntUsage, th32ProcessID; public IntPtr th32DefaultHeapID; public uint th32ModuleID, cntThreads, th32ParentProcessID; public int pcPriClassBase; public uint dwFlags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile; }
        [StructLayout(LayoutKind.Sequential)] class MEMSTAT { public uint dwLength = 64, dwMemoryLoad; public ulong TotalPhys, AvailPhys, TotalPageFile, AvailPageFile, TotalVirtual, AvailVirtual, AvailExtendedVirtual; }
        struct Entry { public int Ppid; public uint Threads; public string Name; }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
        [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int cls, ref EXT info, uint size);
        [DllImport("kernel32.dll")] static extern bool QueryInformationJobObject(IntPtr job, int cls, ref EXT info, uint size, IntPtr ret);
        [DllImport("kernel32.dll")] static extern bool QueryInformationJobObject(IntPtr job, int cls, ref ACCT info, uint size, IntPtr ret);
        [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
        [DllImport("kernel32.dll")] static extern bool TerminateJobObject(IntPtr job, uint code);
        [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
        [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
        [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
        [DllImport("kernel32.dll")] static extern uint GetPriorityClass(IntPtr process);
        [DllImport("kernel32.dll")] static extern bool SetPriorityClass(IntPtr process, uint cls);
        [DllImport("kernel32.dll")] static extern bool SetProcessInformation(IntPtr process, int cls, ref THROTTLE info, uint size);
        [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
        [DllImport("kernel32.dll", EntryPoint = "K32GetProcessMemoryInfo")] static extern bool GetProcessMemoryInfo(IntPtr process, ref PMC counters, uint size);
        [DllImport("kernel32.dll")] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snapshot, ref PE32 entry);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr snapshot, ref PE32 entry);
        [DllImport("kernel32.dll")] static extern bool GlobalMemoryStatusEx([In, Out] MEMSTAT status);

        /// Available physical memory and commit headroom (commit limit minus committed), in MiB.
        public static void MemoryStatus(out long availMiB, out long headroomMiB)
        {
            var m = new MEMSTAT(); GlobalMemoryStatusEx(m);
            availMiB = (long)(m.AvailPhys >> 20); headroomMiB = (long)(m.AvailPageFile >> 20);
        }
        /// Normal priority and EcoQoS off (PROCESS_POWER_THROTTLING_EXECUTION_SPEED explicitly cleared); never lowers a priority.
        static void Tune(Member m)
        {
            m.PriorityBefore = GetPriorityClass(m.Handle);
            if (m.PriorityBefore != NORMAL) SetPriorityClass(m.Handle, NORMAL);
            m.PriorityAfter = GetPriorityClass(m.Handle);
            var t = new THROTTLE { Version = 1, ControlMask = 1, StateMask = 0 };
            m.EcoQosOff = SetProcessInformation(m.Handle, 4, ref t, 12);
        }
        public static string TuneSelf()
        {
            var m = new Member { Handle = GetCurrentProcess() }; Tune(m);
            return string.Format("priority 0x{0:x} -> 0x{1:x}, ecoqos_off={2}", m.PriorityBefore, m.PriorityAfter, m.EcoQosOff);
        }
        static Dictionary<int, Entry> Snapshot()
        {
            var d = new Dictionary<int, Entry>();
            IntPtr s = CreateToolhelp32Snapshot(2, 0);
            if (s == new IntPtr(-1)) return d;
            var e = new PE32(); e.dwSize = (uint)Marshal.SizeOf(typeof(PE32));
            if (Process32FirstW(s, ref e)) do { d[(int)e.th32ProcessID] = new Entry { Ppid = (int)e.th32ParentProcessID, Threads = e.cntThreads, Name = e.szExeFile }; } while (Process32NextW(s, ref e));
            CloseHandle(s);
            return d;
        }
        static bool Counters(IntPtr h, out PMC c) { c = new PMC(); c.cb = (uint)Marshal.SizeOf(typeof(PMC)); return GetProcessMemoryInfo(h, ref c, c.cb); }
        static void Peaks(Member m)
        {
            PMC c; if (!Counters(m.Handle, out c)) return;
            m.OsPeakWs = Math.Max(m.OsPeakWs, (long)c.PeakWorkingSetSize.ToUInt64());
            m.OsPeakCommit = Math.Max(m.OsPeakCommit, (long)c.PeakPagefileUsage.ToUInt64());
        }
        /// One sample: adopt new descendants (by parent PID, created after their parent), then sum the live members.
        static void Tick(Dictionary<int, Member> tree, Outcome o, StreamWriter csv, Stopwatch clock)
        {
            var snap = Snapshot();
            for (bool added = true; added; )
            {
                added = false;
                foreach (var kv in snap)
                {
                    Member parent;
                    if (tree.ContainsKey(kv.Key) || !tree.TryGetValue(kv.Value.Ppid, out parent)) continue;
                    IntPtr h = OpenProcess(0x1000 | 0x0400 | 0x0010 | 0x0200, false, kv.Key);
                    if (h == IntPtr.Zero) continue;
                    long created, exited, kernel, user; GetProcessTimes(h, out created, out exited, out kernel, out user);
                    if (created < parent.Created) { CloseHandle(h); continue; } // a reused PID, not a child
                    var m = new Member { Pid = kv.Key, ParentPid = kv.Value.Ppid, Name = kv.Value.Name, Created = created, Handle = h, Owned = true };
                    Tune(m); tree[m.Pid] = m; o.Members.Add(m); added = true;
                }
            }
            long ws = 0, priv = 0; int threads = 0, procs = 0; var detail = new StringBuilder();
            foreach (var m in tree.Values)
            {
                uint code; Entry e; PMC c;
                if (!GetExitCodeProcess(m.Handle, out code) || code != STILL_ACTIVE || !snap.TryGetValue(m.Pid, out e) || !Counters(m.Handle, out c)) continue;
                long w = (long)c.WorkingSetSize.ToUInt64(), p = (long)c.PrivateUsage.ToUInt64();
                ws += w; priv += p; threads += (int)e.Threads; procs++;
                m.MaxWs = Math.Max(m.MaxWs, w); m.MaxPrivate = Math.Max(m.MaxPrivate, p);
                m.OsPeakWs = Math.Max(m.OsPeakWs, (long)c.PeakWorkingSetSize.ToUInt64()); m.OsPeakCommit = Math.Max(m.OsPeakCommit, (long)c.PeakPagefileUsage.ToUInt64());
                detail.AppendFormat(CultureInfo.InvariantCulture, "{0}{1}:{2}:{3:F1}:{4:F1}:{5}", detail.Length > 0 ? "|" : "", m.Name, m.Pid, w / 1048576.0, p / 1048576.0, e.Threads);
            }
            long avail, head; MemoryStatus(out avail, out head);
            o.PeakTreeWs = Math.Max(o.PeakTreeWs, ws); o.PeakTreePrivate = Math.Max(o.PeakTreePrivate, priv);
            o.MaxThreads = Math.Max(o.MaxThreads, threads); o.MaxProcs = Math.Max(o.MaxProcs, procs);
            o.MinAvail = Math.Min(o.MinAvail, avail); o.MinHeadroom = Math.Min(o.MinHeadroom, head); o.Samples++;
            csv.WriteLine(string.Format(CultureInfo.InvariantCulture, "{0:F3},{1},{2},{3:F1},{4:F1},{5},{6},{7}", clock.Elapsed.TotalSeconds, avail, head, ws / 1048576.0, priv / 1048576.0, procs, threads, detail));
        }
        /// Starts `exe` as runtime.rs `attempt` does (no window, piped stdio, stderr appended to the log, a kill-on-close job object),
        /// writes the one-line request, samples the tree every `intervalMs` until the worker exits, then ends what it left running.
        public static Outcome Run(string exe, string arguments, string[] env, string request, string csvPath, string logPath, int intervalMs)
        {
            var o = new Outcome();
            var psi = new ProcessStartInfo(exe, arguments) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true, StandardOutputEncoding = new UTF8Encoding(false), StandardErrorEncoding = new UTF8Encoding(false) };
            for (int i = 0; i + 1 < env.Length; i += 2) psi.EnvironmentVariables[env[i]] = env[i + 1];
            IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
            var limits = new EXT(); limits.Basic.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(EXT)));
            var gate = new object();
            using (var log = new StreamWriter(logPath, true, new UTF8Encoding(false)))
            using (var csv = new StreamWriter(csvPath, false, new UTF8Encoding(false)))
            using (var p = new Process { StartInfo = psi })
            {
                csv.WriteLine("t_s,available_mib,commit_headroom_mib,tree_ws_mib,tree_private_mib,procs,threads,members(name:pid:ws_mib:private_mib:threads)");
                p.OutputDataReceived += (s, e) => { if (e.Data != null) lock (gate) o.Lines.Add(e.Data); };
                p.ErrorDataReceived += (s, e) => { if (e.Data != null) lock (gate) log.WriteLine(e.Data); };
                var clock = Stopwatch.StartNew();
                p.Start();
                o.JobAssigned = AssignProcessToJobObject(job, p.Handle);
                long created, exited, kernel, user; GetProcessTimes(p.Handle, out created, out exited, out kernel, out user);
                var root = new Member { Pid = p.Id, ParentPid = 0, Name = Path.GetFileName(exe), Created = created, Handle = p.Handle };
                Tune(root);
                var tree = new Dictionary<int, Member>(); tree[root.Pid] = root; o.Members.Add(root);
                p.BeginOutputReadLine(); p.BeginErrorReadLine();
                try
                {
                    var bytes = new UTF8Encoding(false).GetBytes(request + "\n");
                    p.StandardInput.BaseStream.Write(bytes, 0, bytes.Length); p.StandardInput.BaseStream.Flush(); p.StandardInput.Close();
                }
                catch (IOException) { } // the worker exited first; its exit code tells why
                while (true)
                {
                    bool done = p.HasExited;
                    Tick(tree, o, csv, clock);
                    if (done) break;
                    Thread.Sleep(intervalMs);
                }
                foreach (var m in o.Members) Peaks(m); // OS peaks stay readable through an open handle after exit
                var acct = new ACCT();
                if (o.JobAssigned && QueryInformationJobObject(job, 1, ref acct, (uint)Marshal.SizeOf(typeof(ACCT)), IntPtr.Zero)) o.CpuS = (acct.TotalUserTime + acct.TotalKernelTime) / 1e7;
                else o.CpuS = p.TotalProcessorTime.TotalSeconds;
                var ext = new EXT();
                if (o.JobAssigned && QueryInformationJobObject(job, 9, ref ext, (uint)Marshal.SizeOf(typeof(EXT)), IntPtr.Zero)) { o.JobPeakCommit = (long)ext.PeakJobMemoryUsed.ToUInt64(); o.JobPeakProcessCommit = (long)ext.PeakProcessMemoryUsed.ToUInt64(); }
                TerminateJobObject(job, 1); // as the desktop does: whatever the worker left running dies with it
                p.WaitForExit(); // drains stdout and stderr
                o.ExitCode = p.ExitCode; o.WallS = (p.ExitTime - p.StartTime).TotalSeconds;
                foreach (var m in o.Members) if (m.Owned) CloseHandle(m.Handle);
            }
            CloseHandle(job);
            return o;
        }
    }
}
'@

function Get-Full([string]$path) { (Resolve-Path -LiteralPath $path).Path }
function MiB([double]$bytes) { [math]::Round($bytes / 1MB, 1) }
function Test-LivePid([string]$file) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { return $false }
    $id = 0
    [int]::TryParse(((Get-Content -LiteralPath $file -Raw) -replace '\s', ''), [ref]$id) -and $id -ne $PID -and [bool](Get-Process -Id $id -ErrorAction SilentlyContinue)
}
function Get-Room {
    $avail = [int](Get-Counter '\Memory\Available MBytes').CounterSamples[0].CookedValue
    $a = 0L; $head = 0L; [F1Probe.Probe]::MemoryStatus([ref]$a, [ref]$head)
    $sandboxes = @(Get-Process WindowsSandboxClient, WindowsSandboxRemoteSession -ErrorAction SilentlyContinue).Count
    if (Get-Command wsb -ErrorAction SilentlyContinue) { try { $sandboxes += @((wsb list --raw | Out-String | ConvertFrom-Json).WindowsSandboxEnvironments | Where-Object { $_ }).Count } catch { } }
    $perf = $false; $f1 = $false
    if ($LockDir) {
        $lock = Join-Path $LockDir '.perf-lock'
        # A lock folder whose pid file is not written yet counts as live; one whose PID has died does not.
        $perf = (Test-Path -LiteralPath $lock) -and (-not (Test-Path -LiteralPath (Join-Path $lock 'pid')) -or (Test-LivePid (Join-Path $lock 'pid')))
        $f1 = Test-LivePid (Join-Path $LockDir '.f1-running')
    }
    $why = @()
    if ($avail -lt $MinStartAvailMB) { $why += "available $avail MB < $MinStartAvailMB" }
    if ($head -lt $MinStartHeadroomMB) { $why += "commit headroom $head MiB < $MinStartHeadroomMB" }
    if ($sandboxes) { $why += 'Windows Sandbox running' }
    if ($perf) { $why += 'live .perf-lock' }
    if ($f1) { $why += 'another live .f1-running' }
    [pscustomobject]@{ Avail = $avail; AvailApi = $a; Head = $head; Sandbox = [bool]$sandboxes; PerfLock = $perf; Ok = ($why.Count -eq 0); Why = ($why -join '; ') }
}
function Write-Note([string]$text) { Write-Host ("{0:yyyy-MM-dd HH:mm:ss} {1}" -f (Get-Date), $text) }

$App = Get-Full $App; $Models = Get-Full $Models; $InputPath = Get-Full $InputPath
New-Item -ItemType Directory -Force -Path $Out | Out-Null; $Out = Get-Full $Out
if ($LockDir) { $LockDir = Get-Full $LockDir }
$workerDir = Join-Path $App 'worker'; $ffmpeg = Join-Path $App 'runtime\ffmpeg\ffmpeg.exe'; $ffprobe = Join-Path $App 'runtime\ffmpeg\ffprobe.exe'
# runtime.rs engine_for: every stt runs natively by default; separate always runs on the separation pack's Python.
if ($Op -eq 'separate') { if ($Engine -eq 'native') { throw 'separate runs only on the separation pack''s Python (runtime.rs engine_for).' }; $Engine = 'python' }
elseif (-not $Engine) { $Engine = 'native' }
if ($Engine -eq 'native') { $exe = Join-Path $workerDir 'thanham-worker.exe'; $arguments = '' }
elseif ($Op -eq 'separate') {
    # pack.rs ready_python: the pack's python.exe, installed at the revision models.json pins.
    $pack = Join-Path $Models 'separation-runtime'; $exe = Join-Path $pack 'python.exe'
    $pinned = ((Get-Content -LiteralPath (Join-Path $workerDir 'models.json') -Raw -Encoding UTF8 | ConvertFrom-Json).models | Where-Object id -eq 'separation-runtime').revision
    $installed = (Get-Content -LiteralPath (Join-Path $pack 'installed.json') -Raw -Encoding UTF8 | ConvertFrom-Json).revision
    if ($installed -ne $pinned) { throw "Separation pack revision $installed, models.json pins $pinned." }
    $arguments = "-B -I -X utf8 `"$(Join-Path $workerDir 'main.py')`""
}
else { $exe = Join-Path $App 'runtime\python\python.exe'; $arguments = "-I -X utf8 `"$(Join-Path $workerDir 'main.py')`"" }
foreach ($f in $exe, $ffmpeg, $ffprobe) { if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { throw "Missing $f" } }
# runtime.rs attempt: FFmpeg paths and no telemetry for both workers; UTF-8 for Python.
$env = @('THANHAM_FFMPEG', $ffmpeg, 'THANHAM_FFPROBE', $ffprobe, 'HF_HUB_DISABLE_TELEMETRY', '1')
if ($Engine -eq 'python') { $env += @('PYTHONUTF8', '1', 'PYTHONIOENCODING', 'utf-8') }
$modelIds = if ($Op -eq 'separate') { @('htdemucs') } elseif ($Diarize) { @($Model, 'diarization') } else { @($Model) }
foreach ($m in $modelIds) { if (-not (Test-Path -LiteralPath (Join-Path $Models "$m\installed.json"))) { throw "Model $m is not installed in $Models." } }
$inputS = [double](& $ffprobe -v error -show_entries format=duration -of csv=p=0 $InputPath)
Write-Note ("self: " + [F1Probe.Probe]::TuneSelf())

function Invoke-Worker([string]$id, [hashtable]$payload, [string]$operation, [string]$jobDir, [string]$csv) {
    if (Test-Path -LiteralPath $jobDir) { Remove-Item -LiteralPath $jobDir -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $jobDir | Out-Null
    $request = [ordered]@{ protocol = 1; id = $id; operation = $operation; payload = $payload; output_dir = $jobDir; models_dir = $Models } | ConvertTo-Json -Compress -Depth 5
    $o = [F1Probe.Probe]::Run($exe, $arguments, $env, $request, $csv, (Join-Path $jobDir 'worker.log'), $IntervalMs)
    $result = $null; $failure = $null
    foreach ($line in $o.Lines) {
        try { $e = $line | ConvertFrom-Json } catch { continue }
        if ($e.protocol -ne 1 -or $e.id -ne $id) { continue }
        if ($e.event -eq 'result') { $result = $e.result } elseif ($e.event -eq 'error') { $failure = "$($e.code): $($e.message)" }
    }
    [pscustomobject]@{ Outcome = $o; Result = $result; Failure = $failure }
}

# Health first (PLAN F1): the worker must load its engine on this machine.
$health = Invoke-Worker 'f1-health' $(if ($Engine -eq 'python') { @{ profile = $(if ($Op -eq 'separate') { 'separation' } else { 'base' }) } } else { @{} }) 'health' (Join-Path $Out 'jobs\health') (Join-Path $Out 'health.csv')
$health.Result | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $Out 'health.json') -Encoding UTF8
if (-not $health.Result -or $health.Result.ready -ne $true) { throw "Worker health is not ready: $($health.Failure)" }
Write-Note "health ready ($Engine $Op)"

$payload = if ($Op -eq 'separate') { @{ input_path = $InputPath; model_path = (Join-Path $Models 'htdemucs'); ffmpeg_path = $ffmpeg; output_name = $null } }
else {
    $speakerCount = if ($Diarize -and $Speakers -gt 0) { $Speakers } else { $null }
    @{ input_path = $InputPath; model_path = (Join-Path $Models $Model); language = 'vi'; diarize_model_path = $(if ($Diarize) { Join-Path $Models 'diarization' } else { $null }); num_speakers = $speakerCount; min_speakers = $null; max_speakers = $null }
}
$config = Split-Path -Leaf $Out
for ($k = 0; $k -lt $Runs; $k++) {
    $n = 1 + @(Get-ChildItem -LiteralPath $Out -Filter 'run-*.json' -ErrorAction SilentlyContinue).Count
    $waitStart = Get-Date
    while ($true) {
        if ((Get-Date) -gt $Until) { Write-Note "stop: $Until passed before run $n"; exit 4 }
        $room = Get-Room
        if ($room.Ok) { break }
        if (-not $Wait) { Write-Note "refused run ${n}: $($room.Why)"; exit 3 }
        Write-Note "waiting for run ${n}: $($room.Why)"
        Start-Sleep -Seconds $PollSeconds
    }
    $marker = if ($LockDir) { Join-Path $LockDir '.f1-running' } else { $null }
    $id = "f1-$config-$n"; $jobDir = Join-Path $Out "jobs\run-$n"
    if ($Op -eq 'separate') { $payload.output_name = "$id.flac" }
    $started = Get-Date
    try {
        if ($marker) { Set-Content -LiteralPath $marker -Value $PID -NoNewline -Encoding Ascii }
        Write-Note "run $n started: available $($room.Avail) MB, commit headroom $($room.Head) MiB"
        $r = Invoke-Worker $id $payload $Op $jobDir (Join-Path $Out "run-$n.csv")
    }
    finally { if ($marker -and (Test-Path -LiteralPath $marker)) { Remove-Item -LiteralPath $marker -Force } }
    $after = Get-Room
    $o = $r.Outcome; $res = $r.Result
    Get-ChildItem -LiteralPath $jobDir -Filter '*.flac' -ErrorAction SilentlyContinue | Remove-Item -Force # the desktop keeps only worker.log
    $procs = @($o.Members | ForEach-Object { [ordered]@{ name = $_.Name; pid = $_.Pid; parent = $_.ParentPid; peak_working_set_mib = (MiB $_.OsPeakWs); peak_paged_memory_mib = (MiB $_.OsPeakCommit); max_working_set_sampled_mib = (MiB $_.MaxWs); max_private_sampled_mib = (MiB $_.MaxPrivate); priority_before = ('0x{0:x}' -f $_.PriorityBefore); priority_after = ('0x{0:x}' -f $_.PriorityAfter); ecoqos_off = $_.EcoQosOff } })
    $maxProcessPeak = ($o.Members | Measure-Object -Property OsPeakWs -Maximum).Maximum
    $segments = if ($res -and $res.PSObject.Properties['segments']) { @($res.segments) } else { $null }
    $diarizeError = if ($res -and $res.PSObject.Properties['diarize_error_code']) { $res.diarize_error_code } else { $null }
    $reasons = @()
    if ($o.ExitCode -ne 0) { $reasons += "exit code $($o.ExitCode)" }
    if (-not $res) { $reasons += 'no result event' }
    if ($r.Failure) { $reasons += "error event $($r.Failure)" }
    if ($diarizeError) { $reasons += "diarization failed ($diarizeError): the desktop reruns this on Python" }
    if ($o.MinAvail -lt $MinRunAvailMB) { $reasons += "available memory fell to $($o.MinAvail) MiB" }
    if ($after.Sandbox) { $reasons += 'Windows Sandbox running at the end' }
    if ($after.PerfLock) { $reasons += 'live .perf-lock at the end' }
    foreach ($m in $o.Members) { if (-not $m.EcoQosOff -or $m.PriorityAfter -ne 0x20) { $reasons += "$($m.Name) $($m.Pid): priority 0x$('{0:x}' -f $m.PriorityAfter), ecoqos_off=$($m.EcoQosOff)" } }
    $run = [ordered]@{
        run = $n; config = $config; op = $Op; engine = $Engine; model = $(if ($Op -eq 'separate') { 'htdemucs' } else { $Model }); diarize = [bool]$Diarize; num_speakers = $payload['num_speakers']
        input = $InputPath; input_s = $inputS; models_read = $modelIds; started_at = $started.ToString('o'); ended_at = (Get-Date).ToString('o'); waited_s = [math]::Round(($started - $waitStart).TotalSeconds)
        exit_code = $o.ExitCode; result = [bool]$res; error = $r.Failure; rows = $(if ($segments) { $segments.Count } else { $null })
        speakers_found = $(if ($segments) { @($segments | Where-Object { $null -ne $_.speaker } | ForEach-Object { $_.speaker } | Sort-Object -Unique).Count } else { $null }); diarize_error_code = $diarizeError
        # A tree's peak is at least its largest member's OS peak, which the 250 ms samples can miss.
        peak_tree_ws_mib = (MiB ([math]::Max($o.PeakTreeWs, $maxProcessPeak))); peak_tree_ws_sampled_mib = (MiB $o.PeakTreeWs)
        peak_tree_commit_mib = (MiB ([math]::Max($o.PeakTreePrivate, $o.JobPeakCommit))); peak_tree_commit_sampled_mib = (MiB $o.PeakTreePrivate); job_peak_commit_mib = (MiB $o.JobPeakCommit); job_assigned = $o.JobAssigned
        processes = $procs; min_available_mib = $o.MinAvail; min_commit_headroom_mib = $o.MinHeadroom; start_available_mb = $room.Avail; start_commit_headroom_mib = $room.Head
        max_threads = $o.MaxThreads; max_processes = $o.MaxProcs; cpu_s = [math]::Round($o.CpuS, 1); wall_s = [math]::Round($o.WallS, 1); samples = $o.Samples; sample_interval_ms = $IntervalMs
        valid = ($reasons.Count -eq 0); invalid_reasons = $reasons
    }
    $run | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $Out "run-$n.json") -Encoding UTF8
    Write-Note ("run {0} {1}: peak tree working set {2} MiB, commit {3} MiB, min available {4} MiB, {5} s, exit {6}{7}" -f $n, $(if ($run.valid) { 'valid' } else { 'INVALID' }), $run.peak_tree_ws_mib, $run.peak_tree_commit_mib, $o.MinAvail, $run.wall_s, $o.ExitCode, $(if ($reasons) { ': ' + ($reasons -join '; ') } else { '' }))
}

$all = @(Get-ChildItem -LiteralPath $Out -Filter 'run-*.json' | ForEach-Object { Get-Content -LiteralPath $_.FullName -Raw -Encoding UTF8 | ConvertFrom-Json } | Sort-Object run)
$valid = @($all | Where-Object valid)
$peaks = @($valid | ForEach-Object { $_.peak_tree_ws_mib })
$summary = [ordered]@{
    config = $config; runs = @($all | ForEach-Object { [ordered]@{ run = $_.run; valid = $_.valid; peak_tree_ws_mib = $_.peak_tree_ws_mib; peak_tree_commit_mib = $_.peak_tree_commit_mib; wall_s = $_.wall_s; started_at = $_.started_at } })
    valid_runs = $valid.Count
    max_peak_tree_ws_mib = $(if ($peaks) { ($peaks | Measure-Object -Maximum).Maximum } else { $null })
    min_peak_tree_ws_mib = $(if ($peaks) { ($peaks | Measure-Object -Minimum).Minimum } else { $null })
    spread_pct = $(if ($peaks.Count -gt 1) { [math]::Round((($peaks | Measure-Object -Maximum).Maximum / ($peaks | Measure-Object -Minimum).Minimum - 1) * 100, 1) } else { $null })
}
$summary | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $Out 'summary.json') -Encoding UTF8
Write-Note "summary: $($valid.Count)/$($all.Count) valid, max $($summary.max_peak_tree_ws_mib) MiB, spread $($summary.spread_pct) %"
