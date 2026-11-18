# Opts S4's own processes out of Windows power throttling (EcoQoS). Hidden BelowNormal processes on this hybrid CPU were held on the
# 4 E-cores (threads Ready, P-cores idle); this keeps their BelowNormal priority and only lets them use idle P-cores.
# usage: no-ecoqos.ps1 -Ids <pid>[,<pid>...]
param([Parameter(Mandatory)][int[]]$Ids)
Add-Type -Namespace S4 -Name Qos -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
[DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetProcessInformation(IntPtr h, int cls, int[] info, int size);
[DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
'@
foreach ($id in $Ids) {
    $h = [S4.Qos]::OpenProcess(0x0200, $false, $id)  # PROCESS_SET_INFORMATION
    if ($h -eq [IntPtr]::Zero) { "$id open failed"; continue }
    # PROCESS_POWER_THROTTLING_STATE { Version 1, ControlMask EXECUTION_SPEED, StateMask 0 } = never throttle; class 4 = ProcessPowerThrottling
    $ok = [S4.Qos]::SetProcessInformation($h, 4, [int[]](1, 1, 0), 12)
    "$id ecoqos-off=$ok"
    [void][S4.Qos]::CloseHandle($h)
}
