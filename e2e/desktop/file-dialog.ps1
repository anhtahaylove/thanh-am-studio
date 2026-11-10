param([Parameter(Mandatory)][string]$Path, [int]$TimeoutSeconds = 30)
# Fills the native Open/Save common dialog without needing keyboard focus: set the file name
# Edit (inside the file name ComboBox) with WM_SETTEXT, then send IDOK to the dialog.
$ErrorActionPreference = 'Stop'
Add-Type @'
using System; using System.Collections.Generic; using System.Runtime.InteropServices; using System.Text;
public static class Dlg {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr p, EnumProc f, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, string l);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  static string Cls(IntPtr h) { var s = new StringBuilder(256); GetClassName(h, s, 256); return s.ToString(); }
  public static string Fill(string path, uint excludePid) {
    var dialogs = new List<IntPtr>();
    EnumWindows((h, l) => { uint pid; GetWindowThreadProcessId(h, out pid); if (pid != excludePid && IsWindowVisible(h) && Cls(h) == "#32770") dialogs.Add(h); return true; }, IntPtr.Zero);
    foreach (var d in dialogs) {
      IntPtr edit = IntPtr.Zero;
      EnumChildWindows(d, (h, l) => { if (Cls(h) == "Edit" && Cls(GetParent(h)) == "ComboBox") { edit = h; return false; } return true; }, IntPtr.Zero);
      if (edit == IntPtr.Zero) continue;
      SendMessage(edit, 0x000C /*WM_SETTEXT*/, IntPtr.Zero, path);
      PostMessage(d, 0x0111 /*WM_COMMAND*/, (IntPtr)1 /*IDOK*/, IntPtr.Zero);
      return "filled";
    }
    return null;
  }
}
'@
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 700
    if ([Dlg]::Fill($Path, [uint32]$PID)) { Write-Output "filled $Path"; exit 0 }
}
throw "File dialog not found within $TimeoutSeconds s"
