'use strict';

// Is Sunshine (the game-streaming host, streaming/) installed and running on
// this PC? Read-only checks, for the Living Room page:
//   installed  sunshine.exe in its usual install folder
//   running    a sunshine.exe process (tasklist, read-only)
//   webUi      something answers on 127.0.0.1:47990 (Sunshine's web page; a
//              plain TCP connect, nothing is sent to it)
// Never starts, stops or changes Sunshine. The answer is kept for 10 seconds,
// so the page refreshing never runs tasklist more than that.

const fs = require('fs');
const net = require('net');
const path = require('path');
const { execFile } = require('child_process');

const WEB_UI_PORT = 47990;
const CACHE_MS = 10_000;

function installPaths(env = process.env) {
  const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432, 'C:\\Program Files'].filter(Boolean);
  return [...new Set(roots.map((r) => path.join(r, 'Sunshine', 'sunshine.exe')))];
}

function isInstalled(paths = installPaths()) {
  return paths.some((p) => { try { return fs.statSync(p).isFile(); } catch (_) { return false; } });
}

function isRunning() {
  if (process.platform !== 'win32') return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile('tasklist', ['/FI', 'IMAGENAME eq sunshine.exe', '/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 5000 }, (err, out) => {
      if (err) return resolve(false);
      resolve(/"sunshine\.exe"/i.test(String(out)));
    });
  });
}

function portOpen(port = WEB_UI_PORT, host = '127.0.0.1', timeoutMs = 800) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    const done = (v) => { sock.removeAllListeners(); sock.destroy(); resolve(v); };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

/** Returns probe() -> Promise<{ installed, running, webUi }>, cached for CACHE_MS. */
function createProbe({ now = () => Date.now(), checks } = {}) {
  const c = checks || { installed: () => isInstalled(), running: () => isRunning(), webUi: () => portOpen() };
  let cached = null;
  let at = 0;
  let pending = null;
  return function probe() {
    if (cached && now() - at < CACHE_MS) return Promise.resolve(cached);
    if (pending) return pending;
    pending = Promise.all([
      Promise.resolve().then(c.installed).catch(() => false),
      Promise.resolve().then(c.running).catch(() => false),
      Promise.resolve().then(c.webUi).catch(() => false),
    ]).then(([installed, running, webUi]) => {
      // The web page answering means Sunshine runs (even if tasklist missed it).
      cached = { installed: Boolean(installed || running || webUi), running: Boolean(running || webUi), webUi: Boolean(webUi) };
      at = now();
      pending = null;
      return cached;
    });
    return pending;
  };
}

module.exports = { createProbe, installPaths, isInstalled, isRunning, portOpen, WEB_UI_PORT };
