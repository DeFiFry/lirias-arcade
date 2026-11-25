# Opens the app in its own Chrome app window in kiosk mode (called by the launcher .bat).
# - Kiosk fills the screen with no "Press F11/Esc to exit full screen" notice. Leave with the arcade's
#   own Exit button, or Alt+F4 / the Windows key / Alt+Tab.
# - Its own Chrome profile (-ProfileDir), so Paul's normal Chrome is never used, the flags always
#   apply, and Windows gives the window its own taskbar button with the app's icon (the page favicon).
# - If that window is already open, it is brought to the front instead of opening a second one.
param(
  [Parameter(Mandatory)][string]$Chrome,
  [Parameter(Mandatory)][string]$Url,
  [Parameter(Mandatory)][string]$ProfileDir,
  [switch]$Autoplay
)
$ErrorActionPreference = 'Stop'
$ProfileDir = [IO.Path]::GetFullPath($ProfileDir).TrimEnd('\')

Add-Type -Namespace AppWin -Name Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int cmd);
[DllImport("user32.dll")] public static extern bool IsIconic(System.IntPtr h);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h);
public delegate bool EnumProc(System.IntPtr h, System.IntPtr l);
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p, System.IntPtr l);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, out uint pid);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr h);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(System.IntPtr h, System.Text.StringBuilder s, int n);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(System.IntPtr h, System.Text.StringBuilder s, int n);
// The app's own Chrome window: visible, Chrome's window class, with a title.
// (Process.MainWindowHandle can pick a small helper window instead.)
public static System.IntPtr FindAppWindow(uint want) {
  System.IntPtr found = System.IntPtr.Zero;
  EnumWindows((h, l) => {
    uint pid; GetWindowThreadProcessId(h, out pid);
    if (pid != want || !IsWindowVisible(h)) return true;
    var c = new System.Text.StringBuilder(64); GetClassName(h, c, 64);
    if (c.ToString() != "Chrome_WidgetWin_1") return true;
    var t = new System.Text.StringBuilder(256); GetWindowText(h, t, 256);
    if (t.Length == 0) return true;
    found = h; return false;
  }, System.IntPtr.Zero);
  return found;
}
'@

# Chrome's main (browser) process for this profile: no --type= switch in its command line.
# The profile path must end where the --user-data-dir value ends (quote, space or end of line), so a
# Chrome on a look-alike folder (".chrome-app-cinema-old", say) is never taken for this one.
$profileRx = '(?i)--user-data-dir="?' + [regex]::Escape($ProfileDir) + '\\?(?=["\s]|$)'
$main = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object {
  $_.CommandLine -and $_.CommandLine -match $profileRx -and $_.CommandLine -notmatch '--type='
})
foreach ($p in $main) {
  $proc = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
  $h = if ($proc) { [AppWin.Native]::FindAppWindow([uint32]$p.ProcessId) } else { [IntPtr]::Zero }
  if ($h -eq [IntPtr]::Zero -and $proc) { $h = $proc.MainWindowHandle }
  if ($h -ne [IntPtr]::Zero) {
    if ([AppWin.Native]::IsIconic($h)) { [void][AppWin.Native]::ShowWindow($h, 9) }  # SW_RESTORE
    [void](New-Object -ComObject WScript.Shell).AppActivate($p.ProcessId)
    [void][AppWin.Native]::SetForegroundWindow($h)
    Write-Output 'The window was already open: brought it to the front.'
    exit 0
  }
}

$chromeArgs = @("--app=$Url", "--user-data-dir=`"$ProfileDir`"", '--kiosk', '--no-first-run', '--no-default-browser-check')
if ($Autoplay) { $chromeArgs += '--autoplay-policy=no-user-gesture-required' }
Start-Process -FilePath $Chrome -ArgumentList $chromeArgs
Write-Output 'Opened the app window (kiosk: Exit button or Alt+F4 closes it).'
