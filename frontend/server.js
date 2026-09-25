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
const CONFIG = loadConfig();
const cabinet = require('./cabinet');
try { cabinet.init(CONFIG.cabinet); } catch (err) { console.error('[cabinet] init failed:', err.message); }

// A double press can fire two launch requests before the first RetroArch
// window appears; two instances would fight over the same command port.
let lastRomLaunch = 0;

// config.json holds the shared settings. An optional, git-ignored
// config.local.json next to it is merged on top (per system, key by key) for
// personal, per-install settings - e.g. coreOverrides or cabinetToggles that
// name specific ROM files.
function loadConfig() {
  const base = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
  const localPath = path.join(__dirname, 'config.local.json');
  if (!fs.existsSync(localPath)) return base;
  let local;
  try {
    local = JSON.parse(fs.readFileSync(localPath, 'utf8'));
  } catch (err) {
    console.error(`config.local.json ignored - it isn't valid JSON (${err.message})`);
    return base;
  }
  for (const [key, value] of Object.entries(local || {})) {
    if (key === 'systems') {
      if (!value || typeof value !== 'object') continue;
      for (const [sys, sysValue] of Object.entries(value)) {
        base.systems[sys] = { ...(base.systems[sys] || {}), ...sysValue };
      }
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      base[key] = { ...(base[key] || {}), ...value };
    } else {
      base[key] = value;
    }
  }
  return base;
}

// A .gdi (Dreamcast GD-ROM) is an index that references one file per disc track
// sitting beside it in the same folder. Those track files are disc innards, not
// separately launchable games, so they are hidden the way sidecars are - but
// they can't be matched by the basename rule below, since each carries its own
// "_trackNN" suffix rather than sharing the index's basename.
const GDI_TRACK_RE = /_track\d+\.(bin|raw)$/i;

const PORT = process.env.PORT || 8080;

const app = express();
app.use(express.json());
app.use(express.static(__dirname));
app.use('/games', express.static(COLLECTION_DIR));
app.use('/music', express.static(MUSIC_DIR));

function humanize(name) {
  return name
    .replace(/\.[^/.]+$/, '')
    // Wii/GameCube dumps are commonly '<title>.nkit.iso' - stripping the real
    // extension above leaves a trailing '.nkit', which is a container-format
    // tag rather than part of the game's name.
    .replace(/\.nkit$/i, '')
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
    // Multi-track disc systems (e.g. psx) keep the .cue/.toc/.ccd/.sub sidecar
    // files that reference a .bin next to it in the same folder - RetroArch
    // reads the sidecar automatically from the .bin path, so only the .bin
    // itself should show up as a selectable game.
    //
    // Flycast is the opposite: its cue/bin loader needs the .cue itself to
    // get the track layout (the raw .bin alone has no table of contents), so
    // systems opting into launchSidecar list the sidecar file and hide the
    // .bin it describes instead.
    const sidecarExts = CONFIG.systems[system].discSidecarExts || [];
    const launchSidecar = !!CONFIG.systems[system].launchSidecar;
    const files = fs.readdirSync(dir).filter((file) => {
      if (file.startsWith('.')) return false;
      return fs.statSync(path.join(dir, file)).isFile();
    });
    for (const file of files) {
      const ext = path.extname(file).toLowerCase();
      const isSidecar = sidecarExts.includes(ext);
      if (launchSidecar && GDI_TRACK_RE.test(file)) continue;
      if (launchSidecar) {
        const base = path.parse(file).name;
        const hasSidecar = sidecarExts.some((sidecarExt) => files.includes(base + sidecarExt));
        if (!isSidecar && hasSidecar) continue;
      } else if (isSidecar) {
        continue;
      }
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
    if (Date.now() - lastRomLaunch < 3000) return res.json({ type: 'rom', launched: false, ignored: 'already launching' });
    lastRomLaunch = Date.now();

    // Optional per-game core, matched by exact file name (e.g. the widescreen
    // Genesis core for one modded ROM); every other game uses the system core.
    const coreName = (systemConfig.coreOverrides && systemConfig.coreOverrides[file]) || systemConfig.core;
    const corePath = path.join(CONFIG.coresDir, `${coreName}${coreExtension()}`);
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
    const appendConfigs = [];
    if (fs.existsSync(RETROARCH_CONFIG_PATH)) appendConfigs.push(RETROARCH_CONFIG_PATH);

    // Arcade-cabinet side art over the black bars (see cabinet.js). A failure
    // here must never stop the game from launching.
    try {
      const toggle = systemConfig.cabinetToggles && systemConfig.cabinetToggles[file];
      const cabinetCfg = cabinet.prepareLaunch({ system, file, core: coreName, systemConfig, toggle });
      if (cabinetCfg) appendConfigs.push(cabinetCfg);
    } catch (err) {
      console.error('[cabinet] disabled for this launch:', err.message);
    }
    // RetroArch layers several --appendconfig files separated by '|'.
    if (appendConfigs.length) args.push(`--appendconfig=${appendConfigs.join('|')}`);

    try {
      const child = spawn(CONFIG.retroarchPath, args, {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      bringToForeground(child.pid);
      try { cabinet.watch(child); } catch (err) { console.error('[cabinet] watch failed:', err.message); }
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
