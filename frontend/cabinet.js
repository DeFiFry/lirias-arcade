'use strict';

// Arcade-cabinet side art.
//
// Covers the black bars left/right of any RetroArch game with
// frontend/assets/left-side.png and right-side.png, using a RetroArch
// "overlay" (an image drawn on top of the screen - it does not change how the
// game itself is rendered). Games with no side bars (widescreen) get no art.
//
// How it works, per launch:
//  1. An overlay file with two states - ART (sized for the expected bars) and
//     OFF - is generated for this screen size and passed to RetroArch.
//  2. A few seconds in, RetroArch is asked (over its localhost command port)
//     for a GPU screenshot. That screenshot is exactly the size of the game
//     picture, so its width tells us how wide the side bars really are. The
//     overlay is switched to OFF if there are no bars, and the measured width
//     is remembered so that game (and core) starts with the right art next time.
//  3. Games listed with a "cabinetToggle" (e.g. a ROM hack with its own
//     DISPLAY option) instead follow a byte in the game's RAM, live.
//
// Art is scaled to 100% of the screen height, centered in each bar, and
// trimmed equally from both sides when the bar is narrower than the art.
// Generated files live in assets/cabinet-cache/.

const fs = require('fs');
const path = require('path');
const dgram = require('dgram');
const { execFileSync } = require('child_process');
let PNG = null;
try { ({ PNG } = require('pngjs')); } catch { /* not installed yet: side art disabled, games still launch */ }

const ASSETS = path.join(__dirname, 'assets');
const ART = { left: path.join(ASSETS, 'left-side.png'), right: path.join(ASSETS, 'right-side.png') };
const CACHE = path.join(ASSETS, 'cabinet-cache');
const SHOTS = path.join(CACHE, 'shots');
const MEASURED_FILE = path.join(CACHE, 'measured.json');

const DEFAULTS = {
  enabled: true,
  screenWidth: 0,          // 0 = detect the primary display
  screenHeight: 0,
  commandPort: 55355,
  firstCheckMs: 5000,      // first bar measurement after launch
  secondCheckMs: 20000,    // one more (some games switch video mode after boot)
  recheckMs: 15000,        // systems with "cabinetRecheck": keep re-measuring
  noBarsBelowPx: 4,        // bars thinner than this count as "no bars"
  matchTolerancePx: 3,     // measured vs prepared width still counts as a match
};

let settings = { ...DEFAULTS };
let screen = null;
let session = null;        // the one RetroArch game being watched

function log(...a) { console.log('[cabinet]', ...a); }

function init(cfg) {
  settings = { ...DEFAULTS, ...(cfg || {}) };
  try { fs.mkdirSync(SHOTS, { recursive: true }); } catch (e) { log('cache folder:', e.message); }
}

// ---- screen size -----------------------------------------------------------
function screenSize() {
  if (screen) return screen;
  if (settings.screenWidth > 0 && settings.screenHeight > 0) {
    screen = { w: settings.screenWidth, h: settings.screenHeight };
    return screen;
  }
  screen = { w: 1920, h: 1080 };
  if (process.platform === 'win32') {
    try {
      // Physical resolution (not DPI-scaled), which is what fullscreen RetroArch uses.
      const out = execFileSync('powershell', ['-NoProfile', '-Command',
        '(Get-CimInstance Win32_VideoController | Where-Object CurrentHorizontalResolution | ' +
        'Select-Object -First 1 | ForEach-Object { "$($_.CurrentHorizontalResolution)x$($_.CurrentVerticalResolution)" })'],
        { encoding: 'utf8', windowsHide: true, timeout: 15000 }).trim();
      const m = /^(\d+)x(\d+)$/.exec(out);
      if (m) screen = { w: +m[1], h: +m[2] };
    } catch (e) { log('screen detect failed, using 1920x1080:', e.message); }
  }
  log(`screen ${screen.w}x${screen.h}`);
  return screen;
}

// ---- remembered measurements -----------------------------------------------
function loadMeasured() {
  try { return JSON.parse(fs.readFileSync(MEASURED_FILE, 'utf8')); } catch { return { games: {}, cores: {} }; }
}
function saveMeasured(m) {
  try { fs.writeFileSync(MEASURED_FILE, JSON.stringify(m, null, 2)); } catch (e) { log('save failed', e.message); }
}

// ---- image helpers ---------------------------------------------------------
function readPng(file) { return PNG.sync.read(fs.readFileSync(file)); }

// Resample an RGBA region (area-average when shrinking, bilinear when growing).
function resample(src, sx, sy, sw, sh, dw, dh) {
  const out = Buffer.alloc(dw * dh * 4);
  const fx = sw / dw, fy = sh / dh;
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      if (fx >= 1 && fy >= 1) {
        const x0 = sx + x * fx, x1 = x0 + fx, y0 = sy + y * fy, y1 = y0 + fy;
        for (let yy = Math.floor(y0); yy < Math.ceil(y1); yy++) {
          const wy = Math.min(yy + 1, y1) - Math.max(yy, y0);
          for (let xx = Math.floor(x0); xx < Math.ceil(x1); xx++) {
            const wx = Math.min(xx + 1, x1) - Math.max(xx, x0);
            const w = wx * wy, i = (Math.min(Math.max(yy, 0), src.height - 1) * src.width + Math.min(Math.max(xx, 0), src.width - 1)) * 4;
            r += src.data[i] * w; g += src.data[i + 1] * w; b += src.data[i + 2] * w; a += src.data[i + 3] * w; n += w;
          }
        }
      } else {
        const gx = Math.min(Math.max(sx + (x + 0.5) * fx - 0.5, 0), src.width - 1);
        const gy = Math.min(Math.max(sy + (y + 0.5) * fy - 0.5, 0), src.height - 1);
        const x0 = Math.floor(gx), y0 = Math.floor(gy), x1 = Math.min(x0 + 1, src.width - 1), y1 = Math.min(y0 + 1, src.height - 1);
        const tx = gx - x0, ty = gy - y0;
        for (const [xx, yy, w] of [[x0, y0, (1 - tx) * (1 - ty)], [x1, y0, tx * (1 - ty)], [x0, y1, (1 - tx) * ty], [x1, y1, tx * ty]]) {
          const i = (yy * src.width + xx) * 4;
          r += src.data[i] * w; g += src.data[i + 1] * w; b += src.data[i + 2] * w; a += src.data[i + 3] * w; n += w;
        }
      }
      const o = (y * dw + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = a / n;
    }
  }
  return out;
}

// Paste art into a screen-sized RGBA buffer, in the bar barX..barX+barW:
// the art is scaled to 100% of the screen height (never cropped top/bottom)
// and centered in the bar. A narrower bar trims the art equally at both
// sides; a wider bar leaves the extra columns beside the art black.
function pasteArt(dst, dw, dh, art, barX, barW) {
  barW = Math.min(barW, dw - barX);
  if (barW <= 0 || barX < 0) return;
  const scale = dh / art.height;
  const artW = Math.max(1, Math.round(art.width * scale));   // art width on screen
  const showW = Math.min(barW, artW);
  const cropW = Math.min(art.width, showW / scale);          // source columns shown
  const sx = Math.max(0, (art.width - cropW) / 2);
  const px = resample(art, sx, 0, cropW, art.height, showW, dh);
  const x0 = barX + Math.floor((barW - showW) / 2);
  for (let y = 0; y < dh; y++) px.copy(dst, (y * dw + x0) * 4, y * showW * 4, (y + 1) * showW * 4);
}

function artStamp() {
  return ['left', 'right'].map((k) => {
    try { const s = fs.statSync(ART[k]); return `${s.size}-${Math.floor(s.mtimeMs)}`; } catch { return 'none'; }
  }).join('_');
}

// Overlay image for given left/right bar widths (cached).
function overlayImage(leftW, rightW) {
  const { w, h } = screenSize();
  const file = path.join(CACHE, `art-v2_${w}x${h}_${leftW}_${rightW}_${artStamp()}.png`);
  if (fs.existsSync(file)) return file;
  const png = new PNG({ width: w, height: h });
  png.data.fill(0);
  if (fs.existsSync(ART.left)) pasteArt(png.data, w, h, readPng(ART.left), 0, leftW);
  if (fs.existsSync(ART.right)) pasteArt(png.data, w, h, readPng(ART.right), w - rightW, rightW);
  fs.writeFileSync(file, PNG.sync.write(png));
  log('built', path.basename(file));
  return file;
}

function blankImage() {
  const file = path.join(CACHE, 'blank.png');
  if (!fs.existsSync(file)) {
    const png = new PNG({ width: 8, height: 8 }); png.data.fill(0);
    fs.writeFileSync(file, PNG.sync.write(png));     // RetroArch crashes on an overlay state with no image
  }
  return file;
}

const fwd = (p) => p.replace(/\\/g, '/');

// ---- RetroArch command port --------------------------------------------------
function command(text, expectReply = false, timeout = 700) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    let done = false;
    const finish = (v) => { if (!done) { done = true; try { sock.close(); } catch {} resolve(v); } };
    sock.on('error', () => finish(null));
    sock.on('message', (msg) => finish(msg.toString().trim()));
    sock.send(text, settings.commandPort, '127.0.0.1', (err) => {
      if (err) return finish(null);
      if (!expectReply) setTimeout(() => finish(''), 50);
      else setTimeout(() => finish(null), timeout);
    });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Measure the game picture: GPU screenshot size == viewport size.
async function measureViewport() {
  fs.mkdirSync(SHOTS, { recursive: true });
  for (const f of fs.readdirSync(SHOTS)) { try { fs.unlinkSync(path.join(SHOTS, f)); } catch {} }
  await command('SCREENSHOT');
  for (let i = 0; i < 40; i++) {
    await sleep(100);
    const f = fs.readdirSync(SHOTS).find((n) => n.toLowerCase().endsWith('.png'));
    if (!f) continue;
    const full = path.join(SHOTS, f);
    try {
      const head = Buffer.alloc(24);
      const fd = fs.openSync(full, 'r'); fs.readSync(fd, head, 0, 24, 0); fs.closeSync(fd);
      if (head.toString('ascii', 12, 16) !== 'IHDR') continue;          // still being written
      const vw = head.readUInt32BE(16), vh = head.readUInt32BE(20);
      await sleep(200);
      try { fs.unlinkSync(full); } catch {}
      return { vw, vh };
    } catch { /* retry */ }
  }
  return null;
}

async function isPlaying() {
  const r = await command('GET_STATUS', true);
  return !!r && /\bPLAYING\b/.test(r);
}

function barsFor(vw) {
  const { w } = screenSize();
  const total = Math.max(0, w - vw);
  if (total < settings.noBarsBelowPx * 2) return { left: 0, right: 0 };
  const left = Math.floor(total / 2);
  return { left, right: total - left };
}

// ---- per-launch setup ----------------------------------------------------------
// Returns the path of an extra RetroArch config to append for this launch, or null.
function prepareLaunch({ system, file, core, systemConfig, toggle }) {
  if (!settings.enabled) return null;
  if (!PNG) { log('pngjs is missing (run npm install in frontend) - side art off'); return null; }
  if (!fs.existsSync(ART.left) && !fs.existsSync(ART.right)) return null;
  stopSession();
  fs.mkdirSync(SHOTS, { recursive: true });
  if (toggle) {
    const addr = parseInt(toggle.address, 16);
    const okNums = toggle.sourceWidth > toggle.coverWidth && toggle.coverWidth > 0;
    if (!(addr >= 0 && addr <= 0xFFFFFF) || !okNums) {
      log(`ignoring bad cabinetToggles entry for ${file} (address must be a hex 68000 RAM address like FFFFCE)`);
      toggle = null;
    }
  }
  const { w, h } = screenSize();
  const measured = loadMeasured();
  const gameKey = `${system}/${file}`;

  let expected;              // expected {left,right} bars for the ART state
  if (toggle) {
    // Cover the widescreen extension: the outer (sourceWidth - coverWidth)/2
    // columns of the picture, plus any real bars around it.
    const vw = (measured.games[gameKey] && measured.games[gameKey].vw) || w;
    const outer = barsFor(vw);
    const extra = Math.round(vw * (toggle.sourceWidth - toggle.coverWidth) / 2 / toggle.sourceWidth);
    expected = { left: Math.min(outer.left + extra, w >> 1), right: Math.min(outer.right + extra, w >> 1) };
  } else {
    // Arcade/disc systems vary per game, so only trust that game's own measurement.
    const perGame = systemConfig.cabinetPerGame || systemConfig.cabinetRecheck;
    const m = measured.games[gameKey] || (perGame ? null : measured.cores[core]);
    if (m) expected = barsFor(m.vw);
    else {
      const aspect = systemConfig.cabinetAspect || 4 / 3;
      expected = barsFor(Math.round(h * aspect));
    }
  }

  const art = expected.left > 0 ? overlayImage(expected.left, expected.right) : null;
  const states = art ? [art, blankImage()] : [blankImage(), blankImage()];
  const startIndex = toggle ? 1 : 0;       // toggle games start OFF until their RAM byte says ARCADE
  const overlayCfg = path.join(CACHE, 'overlay.cfg');
  const lines = [`overlays = ${states.length}`];
  // RetroArch always starts on overlay0, so put the start state first.
  const ordered = startIndex === 0 ? states : [states[1], states[0]];
  ordered.forEach((img, i) => {
    lines.push(`overlay${i}_overlay = "${fwd(path.relative(CACHE, img))}"`,
      `overlay${i}_full_screen = true`, `overlay${i}_normalized = true`, `overlay${i}_descs = 0`);
  });
  fs.writeFileSync(overlayCfg, lines.join('\n') + '\n');

  const launchCfg = path.join(CACHE, 'launch.cfg');
  fs.writeFileSync(launchCfg, [
    '# Generated by frontend/cabinet.js for each launch - do not edit.',
    'network_cmd_enable = "true"',
    `network_cmd_port = "${settings.commandPort}"`,
    'video_gpu_screenshot = "true"',
    `screenshot_directory = "${fwd(SHOTS)}"`,
    'screenshots_in_content_dir = "false"',
    'sort_screenshots_by_content_enable = "false"',
    'notification_show_screenshot = "false"',
    'notification_show_screenshot_flash = "2"',
    'input_overlay_enable = "true"',
    `input_overlay = "${fwd(overlayCfg)}"`,
    'input_overlay_opacity = "1.000000"',
    'input_overlay_scale_landscape = "1.000000"',
    'input_overlay_x_separation_landscape = "0.000000"',
    'input_overlay_y_separation_landscape = "0.000000"',
    'input_overlay_x_offset_landscape = "0.000000"',
    'input_overlay_y_offset_landscape = "0.000000"',
    'input_overlay_aspect_adjust_landscape = "0.000000"',
    'input_overlay_auto_scale = "false"',
    'input_overlay_auto_rotate = "false"',
    // Keep the overlay loaded (drawn behind RetroArch's menu) so its current
    // state is never reset behind our back when the menu opens/closes.
    'input_overlay_hide_in_menu = "false"',
    'input_overlay_hide_when_gamepad_connected = "false"',
    'input_overlay_behind_menu = "true"',
    'input_overlay_show_inputs = "0"',
    '',
  ].join('\n'));

  // state 0 in the file = what RetroArch shows first
  session = {
    gameKey, core, system, toggle, recheck: !!systemConfig.cabinetRecheck,
    artIndex: startIndex === 0 ? 0 : 1, hasArt: !!art, expected,
    current: 0, timers: [], alive: true, busy: false, lastVw: null,
  };
  return launchCfg;
}

function stopSession() {
  if (!session) return;
  session.alive = false;
  session.timers.forEach(clearTimeout);
  session.timers.forEach(clearInterval);
  session = null;
}

// Switch the overlay to state 0/1 (two states, so one OVERLAY_NEXT flips it).
async function show(s, wantArt) {
  const want = wantArt && s.hasArt ? s.artIndex : 1 - s.artIndex;
  if (s.current === want) return;
  await sleep(80);                        // quick back-to-back commands can be dropped
  if (!s.alive) return;
  await command('OVERLAY_NEXT');
  s.current = want;
}

async function checkBars(s) {
  if (!s.alive || s.busy) return;
  s.busy = true;
  try {
    if (!(await isPlaying()) || !s.alive) return;
    const vp = await measureViewport();
    if (!vp || !s.alive) return;
    if (vp.vh < screenSize().h - 8) return;          // not a full-height picture: don't trust it
    const bars = barsFor(vp.vw);
    if (s.lastVw === vp.vw) {                         // remember only readings that repeat
      const measured = loadMeasured();
      measured.games[s.gameKey] = { vw: vp.vw, vh: vp.vh };
      measured.cores[s.core] = { vw: vp.vw, vh: vp.vh };
      saveMeasured(measured);
    }
    s.lastVw = vp.vw;
    const tol = settings.matchTolerancePx;
    const fits = bars.left > 0 && Math.abs(bars.left - s.expected.left) <= tol && Math.abs(bars.right - s.expected.right) <= tol;
    await show(s, fits);
    log(`${s.gameKey}: picture ${vp.vw}x${vp.vh}, bars ${bars.left}/${bars.right} -> art ${fits ? 'ON' : 'OFF'}` +
      (bars.left > 0 && !fits ? ' (prepared for the next launch)' : ''));
  } finally { s.busy = false; }
}

// RAM byte of a toggle game (68000 address; RetroArch reads Genesis RAM word-swapped).
async function checkToggle(s) {
  if (!s.alive || s.busy) return;
  s.busy = true;
  try {
    if (!(await isPlaying()) || !s.alive) return;
    let addr = parseInt(s.toggle.address, 16);
    if (s.toggle.byteSwapped !== false) addr ^= 1;
    const reply = await command(`READ_CORE_MEMORY ${addr.toString(16).toUpperCase()} 1`, true);
    if (!reply || !s.alive) return;
    const m = /READ_CORE_MEMORY\s+\S+\s+([0-9a-f]{2})/i.exec(reply);
    if (!m) return;
    await show(s, parseInt(m[1], 16) === (s.toggle.arcadeValue ?? 1));
  } finally { s.busy = false; }
}

async function learnWidth(s) {
  if (!s.alive || s.busy) return;
  s.busy = true;
  try {
    if (!(await isPlaying()) || !s.alive) return;
    const vp = await measureViewport();
    if (vp && s.alive) {
      const m = loadMeasured(); m.games[s.gameKey] = { vw: vp.vw, vh: vp.vh }; saveMeasured(m);
    }
  } finally { s.busy = false; }
}

// Start watching the launched RetroArch process.
function watch(child) {
  const s = session;
  if (!s) return;
  const end = () => { if (session === s) stopSession(); };
  child.on('exit', end);
  child.on('error', end);                 // RetroArch failed to start
  if (s.toggle) {
    s.timers.push(setInterval(() => checkToggle(s).catch(() => {}), 300));
    // also learn the real picture width for the next launch
    s.timers.push(setTimeout(() => learnWidth(s).catch(() => {}), settings.firstCheckMs));
    return;
  }
  s.timers.push(setTimeout(() => checkBars(s).catch(() => {}), settings.firstCheckMs));
  s.timers.push(setTimeout(() => checkBars(s).catch(() => {}), settings.secondCheckMs));
  if (s.recheck) s.timers.push(setInterval(() => checkBars(s).catch(() => {}), settings.recheckMs));
}

module.exports = { init, prepareLaunch, watch, stopSession, _internal: { barsFor, overlayImage, measureViewport, screenSize } };
