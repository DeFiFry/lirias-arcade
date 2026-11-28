'use strict';

// The arcade on this PC is unchanged by home network mode. Starts a TEST COPY
// of the real server.js on spare ports with a temp state folder (never port
// 8080, never the real state\, never the running arcade), and checks:
// - with no PIN there is no Living Room listener at all (nothing on its port,
//   not on 127.0.0.1 and not on the LAN address);
// - the PC routes answer as before (page, games, status, launch refusals,
//   shutdown);
// - with a PIN, the Living Room listener opens on its own port, refuses the
//   arcade's routes there, and the PC port still answers exactly the same.
// Never launches a game: /api/launch is only sent requests it refuses.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const lan = require('../lib/lan');

const FRONTEND = path.join(__dirname, '..');

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

function req(method, port, url, { body, host = '127.0.0.1', hostHeader, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host, port, path: url, method, agent: false, headers: { Host: hostHeader || `localhost:${port}`, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, body: text, json });
      });
    });
    r.on('error', reject);
    r.setTimeout(10000, () => r.destroy(new Error('timeout')));
    r.end(body);
  });
}
const postJson = (port, url, obj) => req('POST', port, url, { body: JSON.stringify(obj), headers: { 'Content-Type': 'application/json' } });

function canConnect(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    s.setTimeout(1500, () => { s.destroy(); resolve(false); });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
  });
}

async function startCopy(t, stateDir) {
  const port = await freePort();
  const lanPort = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: FRONTEND,
    env: { ...process.env, PORT: String(port), ARCADE_STATE_DIR: stateDir, ARCADE_LAN_PORT: String(lanPort) },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const exited = new Promise((r) => child.once('exit', (code) => r(code)));
  t.after(async () => { if (child.exitCode === null) { child.kill(); await exited; } });
  const deadline = Date.now() + 20000;
  for (;;) {
    try { if ((await req('GET', port, '/api/status')).status === 200) break; } catch { /* not yet */ }
    if (Date.now() > deadline) throw new Error(`test copy did not start:\n${out}`);
    await new Promise((r) => setTimeout(r, 150));
  }
  // The Living Room listener (if any) opens right after the PC port.
  await new Promise((r) => setTimeout(r, 400));
  return { port, lanPort, child, exited, output: () => out };
}

async function pcRoutesAsBefore(port) {
  const page = await req('GET', port, '/');
  assert.equal(page.status, 200);
  assert.match(page.body, /SELECT YOUR GAME/);
  assert.match(page.body, /id="exit-btn"/);
  assert.equal((await req('GET', port, '/style.css')).status, 200);
  assert.equal((await req('GET', port, '/app.js')).status, 200);
  assert.equal((await req('GET', port, '/site.webmanifest')).status, 200);
  assert.equal((await req('GET', port, '/assets/icon-192.png')).status, 200);
  // Any Host is still answered on the PC port, as before (localhost, 127.0.0.1).
  assert.equal((await req('GET', port, '/api/status', { hostHeader: `127.0.0.1:${port}` })).status, 200);
  const games = await req('GET', port, '/api/games');
  assert.equal(games.status, 200);
  assert.ok(Array.isArray(games.json.games));
  assert.deepEqual((await req('GET', port, '/api/status')).json, { romRunning: false, title: null });
  // Launch refusals only (no game is ever started).
  const missing = await postJson(port, '/api/launch', {});
  assert.equal(missing.status, 400);
  assert.deepEqual(missing.json, { error: 'Missing id' });
  const unknown = await postJson(port, '/api/launch', { id: 'rom:no-such-system:x.bin' });
  assert.equal(unknown.status, 400);
  assert.deepEqual(unknown.json, { error: 'Unknown system: no-such-system' });
  const weird = await postJson(port, '/api/launch', { id: 'nope:1' });
  assert.equal(weird.status, 400);
  return games.json.games.length;
}

test('no PIN: no Living Room listener, the PC routes as before, Exit stops it', async (t) => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'arcade-pc-'));
  t.after(() => fs.rmSync(state, { recursive: true, force: true }));
  const s = await startCopy(t, state);
  await pcRoutesAsBefore(s.port);
  assert.equal(await canConnect(s.lanPort), false, 'nothing on the Living Room port (127.0.0.1)');
  const ip = lan.lanAddresses().find((a) => !a.startsWith('169.254.'));
  if (ip) assert.equal(await canConnect(s.lanPort, ip), false, 'nothing on the Living Room port (LAN address)');
  assert.doesNotMatch(s.output(), /Living Room page/);
  assert.equal(fs.existsSync(path.join(state, 'lan-sessions.json')), false);
  assert.equal(fs.existsSync(path.join(state, 'lan.json')), false, 'no PIN file is ever made by the server');
  // The Exit button's call still stops the server.
  const bye = await postJson(s.port, '/api/shutdown', {});
  assert.deepEqual(bye.json, { ok: true });
  assert.equal(await s.exited, 0);
});

test('with a PIN: the Living Room listener opens on its own port; the PC port answers the same', async (t) => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'arcade-pc-pin-'));
  t.after(() => fs.rmSync(state, { recursive: true, force: true }));
  fs.writeFileSync(path.join(state, 'lan.json'), JSON.stringify({ enabled: true, pin: await lan.makePinRecord('2468') }));
  const s = await startCopy(t, state);
  await pcRoutesAsBefore(s.port);
  assert.match(s.output(), /Living Room page on the home network/);
  assert.equal(await canConnect(s.lanPort), true);
  // Loopback on the Living Room port: the page, but never the arcade's routes.
  const page = await req('GET', s.lanPort, '/', { hostHeader: `lirias-arcade.local:${s.lanPort}` });
  assert.equal(page.status, 200);
  assert.match(page.body, /Living Room/);
  for (const [m, u] of [['GET', '/api/games'], ['GET', '/api/status'], ['POST', '/api/launch'], ['POST', '/api/shutdown'], ['GET', '/music/alice.mp3']]) {
    const r = await req(m, s.lanPort, u, { hostHeader: `lirias-arcade.local:${s.lanPort}`, body: m === 'POST' ? '{"id":"rom:snes:x"}' : undefined, headers: { 'Content-Type': 'application/json' } });
    assert.equal(r.status, 403, `${m} ${u}`);
  }
  const ip = lan.lanAddresses().find((a) => !a.startsWith('169.254.'));
  if (ip) {
    const fromLan = await req('GET', s.lanPort, '/', { host: ip, hostHeader: `${ip}:${s.lanPort}` });
    assert.equal(fromLan.status, 401);
    assert.match(fromLan.body, /Arcade PIN/);
  }
  // Still running, and Exit on the PC still stops everything.
  assert.deepEqual((await req('GET', s.port, '/api/status')).json, { romRunning: false, title: null });
  assert.deepEqual((await postJson(s.port, '/api/shutdown', {})).json, { ok: true });
  assert.equal(await s.exited, 0);
  assert.equal(await canConnect(s.lanPort), false, 'the Living Room listener goes with it');
});
