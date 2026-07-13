'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ROMS_DIR = path.join(ROOT, 'roms');
const COLLECTION_DIR = path.join(ROOT, 'arcade-collection');
const MUSIC_DIR = path.join(ROOT, 'Music');
const RETROARCH_CONFIG_PATH = path.join(ROOT, 'retroarch.cfg');
const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

const PORT = process.env.PORT || 8080;

const app = express();
app.use(express.json());
app.use(express.static(__dirname));
app.use('/games', express.static(COLLECTION_DIR));
app.use('/music', express.static(MUSIC_DIR));

function humanize(name) {
  return name
    .replace(/\.[^/.]+$/, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function coreExtension() {
  if (process.platform === 'win32') return '.dll';
  if (process.platform === 'darwin') return '.dylib';
  return '.so';
}

// The arcade server itself runs hidden/backgrounded (see Launch-Arcade.bat),
// so Windows denies it foreground-activation rights - a plain SetForegroundWindow
// call from it is silently ignored by Windows' foreground-lock protection, and
// any window a spawned game opens comes up unfocused (often minimized to the
// taskbar) instead of being brought to the front. Attaching our thread's input
// queue to the current foreground thread before calling SetForegroundWindow is
// the standard way around that lock. Polling for the child's main window handle
// this way fixes focus without touching how the game itself is launched.
function bringToForeground(pid) {
  if (process.platform !== 'win32') return;
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class ArcadeFocus {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr lpdwProcessId);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}
"@
$HWND_TOPMOST = [IntPtr]::new(-1)
$HWND_NOTOPMOST = [IntPtr]::new(-2)
$SWP_NOMOVE_NOSIZE = 0x3
$VK_MENU = 0x12
$KEYEVENTF_KEYUP = 0x2

# Try repeatedly for a while, and re-check after a short pause even once it
# looks successful - RetroArch's own fullscreen-mode startup can briefly hand
# focus elsewhere again a moment after our first attempt lands.
$deadline = (Get-Date).AddSeconds(20)
while ((Get-Date) -lt $deadline) {
  $p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue
  if ($p -and $p.MainWindowHandle -ne 0) {
    $hwnd = $p.MainWindowHandle
    $confirmed = 0
    while ((Get-Date) -lt $deadline -and $confirmed -lt 2) {
      $foreThread = [ArcadeFocus]::GetWindowThreadProcessId([ArcadeFocus]::GetForegroundWindow(), [IntPtr]::Zero)
      $appThread = [ArcadeFocus]::GetCurrentThreadId()
      $attached = $false
      if ($foreThread -ne 0 -and $foreThread -ne $appThread) {
        $attached = [ArcadeFocus]::AttachThreadInput($appThread, $foreThread, $true)
      }
      # A synthetic Alt tap satisfies one of Windows' own conditions for
      # allowing a foreground switch, on top of the thread-input attach.
      [ArcadeFocus]::keybd_event($VK_MENU, 0, 0, [UIntPtr]::Zero)
      [ArcadeFocus]::ShowWindow($hwnd, 9) | Out-Null
      [ArcadeFocus]::SetWindowPos($hwnd, $HWND_TOPMOST, 0, 0, 0, 0, $SWP_NOMOVE_NOSIZE) | Out-Null
      [ArcadeFocus]::SetWindowPos($hwnd, $HWND_NOTOPMOST, 0, 0, 0, 0, $SWP_NOMOVE_NOSIZE) | Out-Null
      [ArcadeFocus]::BringWindowToTop($hwnd) | Out-Null
      [ArcadeFocus]::SetForegroundWindow($hwnd) | Out-Null
      [ArcadeFocus]::keybd_event($VK_MENU, 0, $KEYEVENTF_KEYUP, [UIntPtr]::Zero)
      if ($attached) {
        [ArcadeFocus]::AttachThreadInput($appThread, $foreThread, $false) | Out-Null
      }
      Start-Sleep -Milliseconds 250
      if ([ArcadeFocus]::GetForegroundWindow() -eq $hwnd) { $confirmed++ } else { $confirmed = 0 }
    }
    break
  }
  Start-Sleep -Milliseconds 200
}
`;
  // detached:true is deliberately NOT used here (unlike the game spawn below) -
  // on Windows it applies the DETACHED_PROCESS creation flag, which starves
  // powershell.exe of a console and makes it die immediately/silently before
  // running any of the script above. .unref() alone is enough to keep this
  // from blocking the server's own process lifetime.
  spawn('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', script], {
    stdio: 'ignore',
    windowsHide: true,
  }).unref();
}

function scanRoms() {
  const games = [];
  for (const system of Object.keys(CONFIG.systems)) {
    const dir = path.join(ROMS_DIR, system);
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir)) {
      if (file.startsWith('.')) continue;
      const full = path.join(dir, file);
      if (!fs.statSync(full).isFile()) continue;
      games.push({
        id: `rom:${system}:${file}`,
        title: humanize(file),
        type: 'rom',
        system,
        systemLabel: CONFIG.systems[system].label,
        file,
      });
    }
  }
  return games;
}

function scanHtml5() {
  const games = [];
  if (!fs.existsSync(COLLECTION_DIR)) return games;
  for (const entry of fs.readdirSync(COLLECTION_DIR)) {
    const full = path.join(COLLECTION_DIR, entry);
    if (!fs.statSync(full).isDirectory()) continue;
    const indexFile = path.join(full, 'index.html');
    if (!fs.existsSync(indexFile)) continue;
    games.push({
      id: `html5:${entry}`,
      title: humanize(entry),
      type: 'html5',
      folder: entry,
      url: `/games/${entry}/index.html`,
    });
  }
  return games;
}

app.get('/api/games', (req, res) => {
  res.json({ games: [...scanHtml5(), ...scanRoms()] });
});

app.post('/api/launch', (req, res) => {
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: 'Missing id' });

  const parts = id.split(':');
  const type = parts[0];

  if (type === 'html5') {
    const folder = parts[1];
    return res.json({ type: 'html5', url: `/games/${folder}/index.html` });
  }

  if (type === 'rom') {
    const [, system, file] = parts;
    const systemConfig = CONFIG.systems[system];
    if (!systemConfig) return res.status(400).json({ error: `Unknown system: ${system}` });

    const romPath = path.join(ROMS_DIR, system, file);
    if (!fs.existsSync(romPath)) return res.status(404).json({ error: `ROM not found: ${file}` });

    const corePath = path.join(CONFIG.coresDir, `${systemConfig.core}${coreExtension()}`);
    if (!fs.existsSync(corePath)) {
      return res.status(500).json({
        error: `Core not found at ${corePath}. Edit frontend/config.json coresDir to point at your RetroArch cores folder.`,
      });
    }

    // --appendconfig layers Lirias-Arcade's own retroarch.cfg (fullscreen,
    // BIOS/system_directory, control bindings) on top of whatever the local
    // RetroArch install's own default config has, without needing every
    // setting duplicated here or the user's global config touched.
    const args = ['-L', corePath, romPath];
    if (fs.existsSync(RETROARCH_CONFIG_PATH)) {
      args.push(`--appendconfig=${RETROARCH_CONFIG_PATH}`);
    }

    try {
      const child = spawn(CONFIG.retroarchPath, args, {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      bringToForeground(child.pid);
      return res.json({ type: 'rom', launched: true });
    } catch (err) {
      return res.status(500).json({ error: `Failed to launch RetroArch: ${err.message}` });
    }
  }

  return res.status(400).json({ error: `Unknown game id: ${id}` });
});

app.post('/api/shutdown', (req, res) => {
  res.json({ ok: true });
  console.log('Shutdown requested from UI — stopping server.');
  setTimeout(() => process.exit(0), 200);
});

const server = app.listen(PORT, () => {
  console.log(`Lirias-Arcade frontend running at http://localhost:${PORT}`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nPort ${PORT} is already in use — the arcade server may already be running.`);
    console.error(`Open http://localhost:${PORT} in your browser, or close the other server window first.\n`);
    process.exit(1);
  }
  throw err;
});
