'use strict';

// The small pages a device on the home network sees: the PIN page, the "home
// network mode is off" page, and the Living Room page itself (status and the
// plain steps for playing on the Mac through Moonlight). The arcade's own look
// (deep navy, cyan borders, yellow titles, magenta highlights, scanlines), all
// inline except the same tab icon set as index.html. No script at all. Same
// idea as Playlist Liria's and Liria Cinema's lib/lan-page.js.

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Inline <style> only; no script at all.
const CSP = "default-src 'none'; img-src 'self'; manifest-src 'self'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

// Exactly the icon links in index.html (a test keeps them the same).
const ICONS = `<link rel="icon" href="/assets/Liria-Arcade-Icon.ico" sizes="256x256" />
<link rel="icon" type="image/png" sizes="16x16" href="/assets/icon-16.png?v=1" />
<link rel="icon" type="image/png" sizes="32x32" href="/assets/icon-32.png?v=1" />
<link rel="icon" type="image/png" sizes="48x48" href="/assets/icon-48.png?v=1" />
<link rel="icon" type="image/png" sizes="192x192" href="/assets/icon-192.png?v=1" />
<link rel="apple-touch-icon" href="/assets/icon-192.png?v=1" />
<link rel="manifest" href="/site.webmanifest?v=1" />`;

function shell(title, body, { wide = false, refresh = 0 } = {}) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
${refresh ? `<meta http-equiv="refresh" content="${Number(refresh)}">\n` : ''}<title>${esc(title)}</title>
<meta name="theme-color" content="#0A0824">
${ICONS}
<style>
:root { color-scheme: dark; --bg: #0A0824; --panel: #1C1A3F; --cyan: #00F0FF; --yellow: #FFEA00; --ink: #FFFFFF; --muted: #B9B6E0;
  --magenta: #FF1AC6; --red: #FF1E3D; --ok: #5CFF9D; --warn: #FFB347; }
* { box-sizing: border-box; }
html, body { margin: 0; min-height: 100%; background: var(--bg); color: var(--ink); }
html { scrollbar-width: thin; scrollbar-color: var(--magenta) var(--bg); }
@supports selector(::-webkit-scrollbar) { html { scrollbar-width: auto; scrollbar-color: auto; } }
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-track { background: var(--bg); }
::-webkit-scrollbar-thumb { background: var(--magenta); border-radius: 6px; border: 2px solid var(--bg); }
::-webkit-scrollbar-thumb:hover { background: var(--cyan); }
::-webkit-scrollbar-button { display: none; }
body { min-height: 100vh; min-height: 100dvh; display: flex; align-items: center; justify-content: center; padding: 16px;
  font: 16px/1.55 "Segoe UI", system-ui, -apple-system, sans-serif; }
body::before { content: ""; position: fixed; inset: 0; pointer-events: none;
  background: repeating-linear-gradient(to bottom, rgba(0, 240, 255, 0.05) 0px, rgba(0, 240, 255, 0.05) 1px, transparent 2px, transparent 4px); }
.card { position: relative; width: 100%; max-width: ${wide ? '720px' : '420px'}; padding: 28px 26px 26px; background: var(--panel);
  border: 2px solid var(--cyan); border-radius: 10px; box-shadow: 0 0 22px rgba(0, 240, 255, 0.35); }
.head { text-align: center; }
.logo { display: block; margin: 0 auto 8px; width: 72px; height: 72px; border-radius: 12px; }
h1 { margin: 0 0 16px; font-size: 1.6rem; font-weight: 700; letter-spacing: 0.08em; color: var(--yellow); text-transform: uppercase;
  text-shadow: 0 0 10px rgba(255, 234, 0, 0.45); }
h2 { margin: 24px 0 10px; font-size: 1.05rem; letter-spacing: 0.1em; text-transform: uppercase; color: var(--cyan); }
p { margin: 0 0 14px; }
.note { font-size: 0.92rem; color: var(--muted); }
.msg { min-height: 1.5em; color: var(--yellow); font-weight: 600; text-align: center; }
.center { text-align: center; }
.sr { position: absolute; left: -9999px; }
input { width: 100%; font: inherit; font-size: 1.8rem; letter-spacing: 0.5em; text-align: center; padding: 8px 0 8px 0.5em; color: var(--ink);
  background: var(--bg); border: 2px solid var(--cyan); border-radius: 8px; }
input:focus { outline: 2px solid var(--magenta); outline-offset: 2px; }
button { margin-top: 16px; width: 100%; font: inherit; font-size: 1.1rem; font-weight: 700; letter-spacing: 0.1em; padding: 10px 0; color: var(--yellow);
  background: var(--red); border: 2px solid var(--yellow); border-radius: 8px; cursor: pointer; box-shadow: 0 0 12px rgba(255, 30, 61, 0.6); }
button:hover { box-shadow: 0 0 10px var(--cyan), 0 0 24px var(--cyan); }
button:focus-visible { outline: 2px solid var(--cyan); outline-offset: 3px; }
.status { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.status li { display: flex; justify-content: space-between; gap: 12px; padding: 10px 14px; background: var(--bg); border: 1px solid rgba(0, 240, 255, 0.35);
  border-radius: 8px; flex-wrap: wrap; }
.status .k { color: var(--muted); }
.status .v { font-weight: 700; text-align: right; }
.ok { color: var(--ok); } .warn { color: var(--warn); } .off { color: var(--muted); }
ol { margin: 0; padding-left: 1.4em; }
ol li { margin: 0 0 8px; }
ol li::marker { color: var(--magenta); font-weight: 700; }
code { font-family: Consolas, "SF Mono", Menlo, monospace; color: var(--yellow); }
@media (max-width: 480px) { .card { padding: 22px 16px 20px; } h1 { font-size: 1.3rem; } }
</style>
</head>
<body>
<main class="card">
<div class="head">
<img class="logo" src="/assets/icon-192.png?v=1" alt="" width="72" height="72">
<h1>Liria's Arcade</h1>
</div>
${body}
</main>
</body>
</html>`;
}

/** message: optional line shown above the field (wrong PIN, wait, ...). */
function pinPage(message = '') {
  return shell("Liria's Arcade", `<p class="center">Enter the Arcade PIN to see the arcade on this device.</p>
<form method="post" action="/lan/pin" autocomplete="off">
<p class="msg" role="status" aria-live="polite">${esc(message)}</p>
<label for="pin" class="sr">Arcade PIN</label>
<input id="pin" name="pin" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="8" autocomplete="current-password" required autofocus>
<button type="submit">ENTER</button>
</form>
<p class="note center" style="margin:20px 0 0">This device is remembered for a year after the right PIN.</p>`);
}

function offPage() {
  return shell("Liria's Arcade", `<p class="center">The arcade on the home network is turned off.</p>
<p class="note center">To turn it on, run Set Arcade PIN on the PC, choose a PIN, then restart Liria's Arcade.</p>`);
}

const row = (k, v, cls) => `<li><span class="k">${esc(k)}</span><span class="v ${cls}">${esc(v)}</span></li>`;

/**
 * The Living Room page. s: { game: { romRunning, title }, sunshine: { installed, running, webUi }, pcAddress }.
 * Read-only: it shows what is happening and how to play on the Mac, and changes nothing.
 */
function livingRoomPage(s = {}) {
  const game = s.game || {};
  const sun = s.sunshine || {};
  const sunText = sun.running ? 'Running' : sun.installed ? 'Installed, not running' : 'Not installed yet';
  const sunCls = sun.running ? 'ok' : sun.installed ? 'warn' : 'off';
  const ip = s.pcAddress || '192.168.1.11';
  const rows = [
    row('Arcade on the PC', 'Running', 'ok'),
    row('Game playing now', game.romRunning ? (game.title || 'A game') : 'None', game.romRunning ? 'ok' : 'off'),
    row('Game streaming (Sunshine)', sunText, sunCls),
  ].join('\n');
  const notReady = sun.running ? '' : `<p class="note">Game streaming is not ready on the PC yet. On the PC, follow docs\\living-room-arcade.md in the arcade folder (run streaming\\Install Game Streaming.bat first).</p>\n`;
  return shell("Liria's Arcade: Living Room", `<p class="center">Play the arcade here on the big screen. The games run on the PC and stream to this Mac.</p>
<h2>Right now</h2>
<ul class="status">
${rows}
</ul>
${notReady}<h2>Play on this Mac</h2>
<ol>
<li>Turn the controller on and pair it with this Mac by Bluetooth (System Settings, Bluetooth). Once paired it reconnects by itself.</li>
<li>Open <strong>Moonlight</strong> on this Mac.</li>
<li>Pick the PC. If it is not listed, press the + button and type <code>${esc(ip)}</code>.</li>
<li>Pick <strong>Liria's Arcade</strong>. The arcade opens on the PC and its picture comes here.</li>
<li>Play with the controller. To stop, quit the game as usual, then leave the stream in Moonlight (Control+Option+Shift+Q on the keyboard, or hold Start+Select+L1+R1 on the controller).</li>
</ol>
<h2>If nothing loads</h2>
<p class="note">On this Mac: System Settings, Network, the Ethernet (USB LAN) connection, Details, TCP/IP, <strong>Renew DHCP Lease</strong>, then wait a full 60 seconds and try again.</p>
<p class="note">This page only shows the arcade's status. Games are started from Moonlight, never from here. It refreshes by itself every 15 seconds.</p>`, { wide: true, refresh: 15 });
}

module.exports = { pinPage, offPage, livingRoomPage, CSP, ICONS };
