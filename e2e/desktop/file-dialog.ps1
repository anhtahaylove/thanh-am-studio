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
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, StringBuilder l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  static string Cls(IntPtr h) { var s = new StringBuilder(256); GetClassName(h, s, 256); return s.ToString(); }
  public static string Fill(string path, uint excludePid) {
    var dialogs = new List<IntPtr>();
    EnumWindows((h, l) => { uint pid; GetWindowThreadProcessId(h, out pid); if (pid != excludePid && IsWindowVisible(h) && Cls(h) == "#32770") dialogs.Add(h); return true; }, IntPtr.Zero);
    foreach (var d in dialogs) {
      IntPtr edit = IntPtr.Zero;
      EnumChildWindows(d, (h, l) => { if (Cls(h) == "Edit" && Cls(GetParent(h)) == "ComboBox") { edit = h; return false; } return true; }, IntPtr.Zero);
      if (edit == IntPtr.Zero) continue;
      string last = "";
      // Let the dialog finish initializing, then type the path as real character input (WM_CHAR)
      // and press Enter in the box; WM_SETTEXT + IDOK is ignored by some Windows builds.
      System.Threading.Thread.Sleep(1500);
      for (int i = 0; i < 5; i++) {
        SendMessage(edit, 0x000C /*WM_SETTEXT*/, IntPtr.Zero, "");
        foreach (char c in path) SendMessage(edit, 0x0102 /*WM_CHAR*/, (IntPtr)c, IntPtr.Zero);
        System.Threading.Thread.Sleep(300);
        var got = new StringBuilder(1024); SendMessage(edit, 0x000D /*WM_GETTEXT*/, (IntPtr)1024, got);
        last = got.ToString();
        if (last == path) {
          PostMessage(edit, 0x0100 /*WM_KEYDOWN*/, (IntPtr)0x0D, IntPtr.Zero);
          PostMessage(edit, 0x0101 /*WM_KEYUP*/, (IntPtr)0x0D, IntPtr.Zero);
          return "filled dialogs=" + dialogs.Count;
        }
        System.Threading.Thread.Sleep(500);
      }
      return "nomatch last=" + last;
    }
    return null;
  }
}
'@
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 700
    $r = [Dlg]::Fill($Path, [uint32]$PID); if ($r) { Write-Output $r; if ($r -like 'filled*') { exit 0 } }
}
throw "File dialog not found within $TimeoutSeconds s"
