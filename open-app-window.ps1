# Opens the app in its own full-screen Chrome app window (called by the launcher .bat).
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
  if ($proc -and $proc.MainWindowHandle -ne [IntPtr]::Zero) {
    $h = $proc.MainWindowHandle
    if ([AppWin.Native]::IsIconic($h)) { [void][AppWin.Native]::ShowWindow($h, 9) }  # SW_RESTORE
    [void](New-Object -ComObject WScript.Shell).AppActivate($p.ProcessId)
    [void][AppWin.Native]::SetForegroundWindow($h)
    Write-Output 'The window was already open: brought it to the front.'
    exit 0
  }
}

$chromeArgs = @("--app=$Url", "--user-data-dir=`"$ProfileDir`"", '--start-fullscreen', '--no-first-run', '--no-default-browser-check')
if ($Autoplay) { $chromeArgs += '--autoplay-policy=no-user-gesture-required' }
Start-Process -FilePath $Chrome -ArgumentList $chromeArgs
Write-Output 'Opened the app window (full screen; F11 leaves full screen).'
