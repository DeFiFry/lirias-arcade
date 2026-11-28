'use strict';

// Home network mode (lib/lan.js, lib/living-room.js, lib/lan-page.js,
// lib/mdns.js, lib/sunshine.js, tools/set-pin.js) and the Sunshine app tool
// (streaming/sunshine-app.js). Modelled on Playlist Liria's test/unit/lan.test.js.
// Temp state folders and port 0 only: never the real state\lan.json, never the
// running arcade, never RetroArch, never the real Sunshine apps.json.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');
const { EventEmitter } = require('events');
const lan = require('../lib/lan');
const lanPage = require('../lib/lan-page');
const { createLivingRoom, LAN_PORT } = require('../lib/living-room');
const { startResponder, addressesFor } = require('../lib/mdns');
const sunshine = require('../lib/sunshine');
const sunshineApp = require('../../streaming/sunshine-app');

const PIN = '2468';
const temps = [];
const mkTmp = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); temps.push(d); return d; };

let room, offRoom, lp, state;
let peer = null; // the client address the server sees (null: the real socket)
let game = { romRunning: false, title: null };
let sun = { installed: false, running: false, webUi: false };

async function writePin(dir, pin, enabled = true) {
  fs.mkdirSync(dir, { recursive: true });
  const rec = await lan.makePinRecord(pin);
  fs.writeFileSync(path.join(dir, 'lan.json'), JSON.stringify({ enabled, pin: rec }));
  const t = new Date(Date.now() + Math.floor(Math.random() * 100000));
  fs.utimesSync(path.join(dir, 'lan.json'), t, t);
}

function makeRoom(stateDir, extra = {}) {
  return createLivingRoom({
    stateDir, port: 0, host: '127.0.0.1', mdns: false,
    getGame: () => game, sunshineProbe: async () => sun,
    peerAddress: (req) => peer || req.socket.remoteAddress, ...extra,
  });
}

before(async () => {
  state = mkTmp('arcade-lan-state-');
  await writePin(state, PIN);
  room = makeRoom(state);
  lp = await room.start();
  offRoom = makeRoom(mkTmp('arcade-lan-off-'));
  await offRoom.start();
});

after(async () => {
  if (room) await room.close();
  if (offRoom) await offRoom.close();
  for (const d of temps) fs.rmSync(d, { recursive: true, force: true });
});

function req(method, url, { headers = {}, body, port = lp, host = '127.0.0.1', hostHeader } = {}) {
  return new Promise((resolve, reject) => {
    const h = { Host: hostHeader ?? `lirias-arcade.local:${port}`, ...headers };
    const r = http.request({ host, port, path: url, method, headers: h, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        const text = raw.toString('utf8');
        let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, body: text, json, raw });
      });
    });
    r.on('error', reject);
    r.end(body);
  });
}
const postPin = (pin, extra = {}) => req('POST', '/lan/pin', { headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...extra }, body: `pin=${encodeURIComponent(pin)}` });

// Every route the arcade app has (server.js), plus its static folders.
const PC_ROUTES = [
  ['GET', '/api/games'], ['GET', '/api/status'], ['POST', '/api/launch'], ['POST', '/api/shutdown'],
  ['GET', '/games/x/index.html'], ['GET', '/music/alice.mp3'], ['GET', '/API/games'], ['GET', '/api'],
];

let cookie = null;

test('addresses: private and loopback ranges', () => {
  for (const ip of ['127.0.0.1', '127.9.9.9', '::1', '::ffff:127.0.0.1']) assert.ok(lan.isLoopback(ip), ip);
  for (const ip of ['10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.11', '169.254.3.4', 'fe80::1', 'fe80::1%12', 'fd12:3456::1', '::ffff:192.168.1.5', '::1'])
    assert.ok(lan.isPrivate(ip), ip);
  for (const ip of ['8.8.8.8', '172.15.0.1', '172.32.0.1', '192.169.0.1', '100.64.0.1', '2001:db8::1', '::ffff:8.8.8.8', '::', '0.0.0.0', '', 'garbage', '::ffff:7f00:1'])
    assert.ok(!lan.isPrivate(ip), ip);
});

test('no collision with Liria Cinema or Playlist Liria: own cookie, own mDNS name, own port', () => {
  assert.equal(lan.COOKIE, 'lirias_arcade_lan');
  assert.ok(!['liria_lan', 'playlist_liria_lan'].includes(lan.COOKIE));
  assert.equal(lan.MDNS_NAME, 'lirias-arcade.local');
  assert.equal(LAN_PORT, 6969);
  assert.ok(![8080, 8095, 8096].includes(LAN_PORT));
});

test('a LAN device without the cookie gets the PIN page; nothing else', async () => {
  peer = '192.168.1.50';
  const page = await req('GET', '/');
  assert.equal(page.status, 401);
  assert.match(page.headers['content-type'], /html/);
  assert.match(page.body, /Arcade PIN/);
  assert.match(page.body, /action="\/lan\/pin"/);
  assert.doesNotMatch(page.body, /\u2014/, 'no em dashes');
  assert.doesNotMatch(page.body, /8080/, 'the PC port is never shown');
  assert.doesNotMatch(page.body, /<script/i);
  assert.equal(page.headers['cache-control'], 'no-store');
  assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.match(page.headers['content-security-policy'], /default-src 'none'/);
  assert.equal(page.headers['referrer-policy'], 'same-origin');
  assert.equal((await req('GET', '/api/living-room')).status, 401);
  for (const u of ['/index.html', '/living-room', '/app.js', '/style.css', '/server.js', '/titles.json', '/config.json']) {
    const r = await req('GET', u);
    assert.ok(r.status === 401 || r.status === 404, `${u}: ${r.status}`);
    assert.doesNotMatch(r.body, /require\(|"systems"|retroarchPath/, u);
  }
  const spoof = await req('GET', '/api/living-room', { headers: { 'X-Forwarded-For': '127.0.0.1', 'X-Real-IP': '127.0.0.1', Forwarded: 'for=127.0.0.1' } });
  assert.equal(spoof.status, 401);
});

test('before the PIN: the arcade tab icons load, by exact path only', async () => {
  peer = '192.168.1.51';
  const icons = ['/favicon.ico', '/assets/Liria-Arcade-Icon.ico', '/assets/icon-16.png?v=1', '/assets/icon-32.png?v=1', '/assets/icon-48.png?v=1',
    '/assets/icon-192.png?v=1', '/assets/icon-512.png', '/apple-touch-icon.png', '/apple-touch-icon-precomposed.png'];
  for (const u of icons) {
    for (const method of ['GET', 'HEAD']) {
      const r = await req(method, u);
      assert.equal(r.status, 200, `${method} ${u}`);
      assert.match(r.headers['content-type'], /^image\//, u);
      assert.equal(r.headers['set-cookie'], undefined, u);
    }
  }
  const touch = fs.readFileSync(path.join(__dirname, '../assets/icon-192.png'));
  assert.ok((await req('GET', '/apple-touch-icon-precomposed.png')).raw.equals(touch));
  const mf = await req('GET', '/site.webmanifest?v=1');
  assert.equal(mf.status, 200);
  assert.match(mf.body, /icon-192\.png/);
  for (const u of ['/assets/Liria-Arcade-Banner.jpg', '/assets/left-side.png', '/assets/cabinet-cache/measured.json', '/assets/icon-64.png', '/FAVICON.ICO',
    '/favicon.ico/', '/assets/icon-32.png/', '/assets/%2e%2e/server.js', '/assets/icon-32.png/../../server.js', '/assets/icon-32.png%00.js']) {
    const r = await req('GET', u);
    assert.ok(r.status >= 400, `${u}: ${r.status}`);
    assert.doesNotMatch(String(r.headers['content-type'] || ''), /^image\//, u);
  }
  // The PIN page links the same icon set as index.html, and its CSP lets the manifest load.
  const page = await req('GET', '/');
  const links = (b) => (b.match(/<link rel="(icon|apple-touch-icon|manifest)"[^>]*>/g) || []).join('|');
  const index = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  assert.ok(links(index).length > 0);
  assert.equal(links(page.body), links(index));
  assert.match(page.headers['content-security-policy'], /manifest-src 'self'/);
});

test('non-private addresses are refused outright, whatever the headers say', async () => {
  for (const ip of ['8.8.8.8', '::ffff:8.8.8.8', '2001:db8::5', '100.64.1.1']) {
    peer = ip;
    const r = await req('GET', '/', { headers: { 'X-Forwarded-For': '192.168.1.5' } });
    assert.equal(r.status, 403, ip);
    assert.doesNotMatch(r.body, /PIN/);
    assert.equal((await postPin(PIN)).status, 403, ip);
    assert.equal((await req('GET', '/favicon.ico')).status, 403, ip);
  }
  peer = null;
});

test('wrong PINs are rate limited per address (5 tries, then a wait)', async () => {
  peer = '192.168.1.66';
  for (let i = 1; i <= 4; i++) {
    const r = await postPin('1111');
    assert.equal(r.status, 401);
    assert.match(r.body, new RegExp(`${5 - i} tr(y|ies) left`));
    assert.equal(r.headers['set-cookie'], undefined);
  }
  const fifth = await postPin('9999');
  assert.equal(fifth.status, 429);
  assert.match(fifth.body, /Try again in 1 minute/);
  const locked = await postPin(PIN);
  assert.equal(locked.status, 429);
  assert.equal(locked.headers['set-cookie'], undefined);
  peer = '192.168.1.67';
  assert.equal((await req('POST', '/lan/pin', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: PIN }) })).status, 415);
  const big = await req('POST', '/lan/pin', { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `pin=${'1'.repeat(5000)}` }).catch(() => ({ status: 413 }));
  assert.ok(big.status >= 400, String(big.status));
  assert.equal(big.headers && big.headers['set-cookie'], undefined);
});

test('lockouts grow: 1, 2, 4 minutes; a global limit; parallel guesses turned away (fake clock)', async () => {
  const dir = mkTmp('arcade-lan-clock-');
  await writePin(dir, '5555');
  let now = 1_000_000;
  const a = new lan.LanAuth(dir, { now: () => now });
  const lockFor = async () => { let r; for (let i = 0; i < 5; i++) r = await a.tryPin('10.0.0.9', '0000'); return r; };
  let r = await lockFor();
  assert.equal(r.reason, 'locked');
  assert.equal(r.wait, 60_000);
  now += 60_001;
  r = await lockFor();
  assert.equal(r.wait, 120_000);
  now += 120_001;
  r = await lockFor();
  assert.equal(r.wait, 240_000);
  assert.equal(a.lockedFor('10.0.0.10'), 0);
  now += 240_001;
  assert.equal((await a.tryPin('10.0.0.9', '5555')).ok, true);
  const b = new lan.LanAuth(dir, { now: () => now });
  for (let i = 0; i < 31; i++) await b.tryPin(`10.0.1.${i}`, '0000');
  assert.ok(b.lockedFor('10.0.2.1') > 0);
  assert.equal((await b.tryPin('10.0.2.1', '5555')).reason, 'locked');
  const c = new lan.LanAuth(dir, { now: () => now });
  const flood = await Promise.all(Array.from({ length: 12 }, () => c.tryPin('10.0.3.1', '0000')));
  assert.equal(flood.filter((x) => x.reason === 'wrong').length, 1);
  assert.equal(flood.filter((x) => x.reason === 'busy').length, 11);
  assert.equal(lan.PIN_RE.test('123'), false);
  await assert.rejects(lan.makePinRecord('12a4'));
});

test('the right PIN sets a year-long HttpOnly SameSite=Strict cookie; then the Living Room page shows', async () => {
  peer = '192.168.1.70';
  const r = await postPin(PIN, { Origin: `http://lirias-arcade.local:${lp}`, 'Sec-Fetch-Site': 'same-origin' });
  assert.equal(r.status, 303);
  assert.equal(r.headers.location, '/');
  const sc = r.headers['set-cookie'][0];
  assert.match(sc, /^lirias_arcade_lan=[A-Za-z0-9_-]{43};/);
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /SameSite=Strict/);
  assert.match(sc, /Max-Age=31536000/);
  cookie = sc.split(';')[0];
  room.lanAuth.saveNow();
  const saved = fs.readFileSync(path.join(state, 'lan-sessions.json'), 'utf8');
  assert.ok(!saved.includes(cookie.split('=')[1]), 'only the token hash is stored');
  assert.ok(!fs.readFileSync(path.join(state, 'lan.json'), 'utf8').includes(PIN), 'the PIN is stored nowhere');

  game = { romRunning: false, title: null };
  sun = { installed: false, running: false, webUi: false };
  let home = await req('GET', '/', { headers: { Cookie: cookie } });
  assert.equal(home.status, 200);
  assert.match(home.body, /Living Room/);
  assert.match(home.body, /Moonlight/);
  assert.match(home.body, /Liria&#39;s Arcade/);
  assert.match(home.body, /Not installed yet/);
  assert.match(home.body, /Renew DHCP Lease/);
  assert.match(home.body, /60 seconds/);
  assert.doesNotMatch(home.body, /<script|<form|<button/i, 'read only: no forms, buttons or scripts');
  assert.doesNotMatch(home.body, /\u2014/, 'no em dashes');
  assert.doesNotMatch(home.body, /8080/);

  game = { romRunning: true, title: 'Golden Axe - Mod <b>' };
  sun = { installed: true, running: true, webUi: true };
  home = await req('GET', '/', { headers: { Cookie: cookie } });
  assert.match(home.body, /Golden Axe - Mod &lt;b&gt;/, 'titles are escaped');
  assert.match(home.body, /class="v ok">Running</);
  const api = await req('GET', '/api/living-room', { headers: { Cookie: cookie } });
  assert.equal(api.status, 200);
  assert.deepEqual(api.json.game, { romRunning: true, title: 'Golden Axe - Mod <b>' });
  assert.deepEqual(api.json.sunshine, sun);
  assert.equal(api.json.arcade, 'running');
  sun = { installed: true, running: false, webUi: false };
  home = await req('GET', '/', { headers: { Cookie: cookie } });
  assert.match(home.body, /Installed, not running/);

  // Forged, wrong-shaped or other apps' cookies do not work.
  for (const c of [`lirias_arcade_lan=${'A'.repeat(43)}`, `${cookie}x`, `playlist_liria_lan=${cookie.split('=')[1]}`, `liria_lan=${cookie.split('=')[1]}`])
    assert.equal((await req('GET', '/api/living-room', { headers: { Cookie: c } })).status, 401, c);
  // The cookie works from another LAN address too.
  peer = '10.1.2.3';
  assert.equal((await req('GET', '/api/living-room', { headers: { Cookie: cookie } })).status, 200);
});

test('read only: every arcade route is 403 from the LAN, with the PIN, and even from loopback on this port', async () => {
  const own = { Origin: `http://lirias-arcade.local:${lp}`, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' };
  for (const who of ['192.168.1.70', '192.168.1.99', null]) {
    peer = who;
    for (const [method, u] of PC_ROUTES) {
      const r = await req(method, u, { headers: { Cookie: cookie, ...own }, body: method === 'POST' ? JSON.stringify({ id: 'rom:snes:x.sfc' }) : undefined });
      assert.equal(r.status, 403, `${who} ${method} ${u}`);
      assert.match(r.json.error, /Only on the PC/);
    }
    // No other write exists here.
    for (const [method, u] of [['POST', '/'], ['PUT', '/api/living-room'], ['DELETE', '/'], ['POST', '/living-room'], ['POST', '/api/living-room']]) {
      const r = await req(method, u, { headers: { Cookie: cookie, ...own }, body: '{}' });
      assert.equal(r.status, 403, `${who} ${method} ${u}`);
    }
  }
  peer = null;
});

test('loopback on the Living Room port never needs the PIN', async () => {
  peer = null;
  assert.equal((await req('GET', '/', { hostHeader: `127.0.0.1:${lp}` })).status, 200);
  assert.equal((await req('GET', '/api/living-room', { hostHeader: `localhost:${lp}` })).status, 200);
  assert.equal((await postPin('0000')).status, 303);
});

test('CSRF and Host: foreign origins refused, the own name and own origin allowed', async () => {
  peer = '192.168.1.80';
  for (const h of [
    { Origin: 'http://evil.example' }, { Origin: 'null' }, { Origin: `http://localhost:${lp}` }, { Origin: 'http://localhost:8080' },
    { Origin: `https://lirias-arcade.local:${lp}` }, { Origin: `http://lirias-arcade.local:${lp}.evil.example` },
    { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' },
  ]) assert.equal((await postPin(PIN, h)).status, 403, JSON.stringify(h));
  const ok = await req('POST', '/lan/pin', { hostHeader: `LIRIAS-ARCADE.local:${lp}`, headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: `http://LIRIAS-ARCADE.local:${lp}` }, body: `pin=${PIN}` });
  assert.equal(ok.status, 303);
  for (const host of ['evil.example', `evil.example:${lp}`, `lirias-arcade.local.evil.example:${lp}`, `lirias-arcade.local:${lp + 1}`, 'lirias-arcade.local',
    `lirias-arcade.local:8080`, `liria-cinema.local:${lp}`, `playlist-liria.local:${lp}`, `192.168.1.80:${lp}`, `${os.hostname()}.evil:${lp}`]) {
    assert.equal((await req('GET', '/api/living-room', { hostHeader: host, headers: { Cookie: cookie } })).status, 421, host);
  }
  assert.equal((await req('GET', '/api/living-room', { headers: { Cookie: cookie, 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  peer = null;
});

test('a new PIN, or turning the mode off, forgets every remembered device at once', async () => {
  peer = '192.168.1.70';
  assert.equal((await req('GET', '/api/living-room', { headers: { Cookie: cookie } })).status, 200);
  await writePin(state, '13579');
  assert.equal((await req('GET', '/api/living-room', { headers: { Cookie: cookie } })).status, 401);
  peer = '192.168.1.71';
  const r = await postPin('13579');
  assert.equal(r.status, 303);
  const c2 = r.headers['set-cookie'][0].split(';')[0];
  assert.equal((await req('GET', '/api/living-room', { headers: { Cookie: c2 } })).status, 200);
  fs.writeFileSync(path.join(state, 'lan.json'), JSON.stringify({ enabled: false }));
  const t = new Date(Date.now() + 500_000); fs.utimesSync(path.join(state, 'lan.json'), t, t);
  const off = await req('GET', '/', { headers: { Cookie: c2 } });
  assert.equal(off.status, 503);
  assert.match(off.body, /turned off/);
  assert.match(off.body, /Set Arcade PIN/);
  assert.equal((await req('GET', '/api/living-room', { headers: { Cookie: c2 } })).status, 503);
  assert.equal((await postPin('13579')).status, 503);
  peer = null;
});

test('a request line no parser accepts is a quiet 400', async () => {
  const rawLine = (port, host) => new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1', () => sock.write(`GET // HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`));
    let out = ''; sock.on('data', (d) => { out += d; }); sock.on('end', () => resolve(out)); sock.on('error', () => resolve(out));
  });
  peer = '192.168.1.50';
  assert.match(await rawLine(lp, `lirias-arcade.local:${lp}`), /^HTTP\/1\.1 400/);
  peer = null;
});

test('no PIN set: no Living Room listener at all', async () => {
  assert.equal(offRoom.server, null);
  assert.equal(offRoom.port, null);
  assert.equal(room.server.listening, true);
});

test('the Living Room port taken: start resolves null, nothing thrown', async () => {
  const dir = mkTmp('arcade-lan-busy-');
  await writePin(dir, PIN);
  const blocker = http.createServer();
  await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
  const a = makeRoom(dir, { port: blocker.address().port });
  const errors = [];
  const orig = console.error; console.error = (m) => errors.push(String(m));
  try {
    assert.equal(await a.start(), null);
    assert.equal(a.server, null);
    assert.ok(errors.some((m) => /already in use/.test(m) && /works as usual/.test(m)));
  } finally {
    console.error = orig;
    await a.close();
    await new Promise((r) => blocker.close(r));
  }
});

test('closing never writes the devices file when nothing changed, and a close while opening leaks nothing', async () => {
  const dir = mkTmp('arcade-lan-close-');
  await writePin(dir, PIN);
  const quiet = makeRoom(dir);
  await quiet.start();
  await quiet.close();
  assert.equal(fs.existsSync(path.join(dir, 'lan-sessions.json')), false);
  const racing = makeRoom(dir);
  const opening = racing.start();
  await racing.close();
  await opening;
  assert.equal(racing.server, null);
});

test('a real connection from this PC\'s own LAN address (0.0.0.0 listener) is another device', async (t) => {
  const ip = lan.lanAddresses().find((a) => !a.startsWith('169.254.'));
  if (!ip) return t.skip('no private LAN address on this machine');
  const dir = mkTmp('arcade-lan-real-');
  await writePin(dir, PIN);
  const a = makeRoom(dir, { host: '0.0.0.0', peerAddress: undefined });
  try {
    const p = await a.start();
    const r = await req('GET', '/', { host: ip, port: p, hostHeader: `${ip}:${p}` });
    assert.equal(r.status, 401);
    assert.match(r.body, /Arcade PIN/);
    assert.equal((await req('GET', '/api/games', { host: ip, port: p, hostHeader: `${ip}:${p}` })).status, 403);
  } finally {
    await a.close();
  }
});

test('mDNS: answers only for lirias-arcade.local, only with private IPv4, only while on', () => {
  const sock = new EventEmitter();
  sock.sent = [];
  sock.respond = (pkt, cb) => { sock.sent.push(pkt); if (cb) cb(); };
  sock.destroy = () => { sock.destroyed = true; };
  let on = true;
  const ifs = [
    { address: '192.168.1.11', netmask: '255.255.255.0' },
    { address: '169.254.28.2', netmask: '255.255.0.0' },
    { address: '8.8.8.8', netmask: '255.255.255.0' },
    { address: '127.0.0.1', netmask: '255.0.0.0' },
  ];
  const r = startResponder({ factory: () => sock, isOn: () => on, interfaces: () => ifs });
  const ask = (name, type, from) => { const n = sock.sent.length; sock.emit('query', { questions: [{ name, type }] }, { address: from, port: 5353 }); return sock.sent.slice(n); };
  let got = ask('lirias-arcade.local', 'A', '192.168.1.40');
  assert.deepEqual(got[0].answers.map((a) => [a.name, a.type, a.data]), [['lirias-arcade.local', 'A', '192.168.1.11']]);
  got = ask('LIRIAS-ARCADE.LOCAL', 'ANY', '192.168.1.41');
  assert.equal(got.length, 1);
  for (const pkt of sock.sent) for (const a of pkt.answers) assert.ok(lan.isPrivate(a.data) && !lan.isLoopback(a.data), a.data);
  assert.equal(ask('liria-cinema.local', 'A', '192.168.1.40').length, 0);
  assert.equal(ask('playlist-liria.local', 'A', '192.168.1.40').length, 0);
  assert.equal(ask('lirias-arcade.local.evil', 'A', '192.168.1.40').length, 0);
  assert.equal(ask('lirias-arcade.local', 'AAAA', '192.168.1.40').length, 0);
  assert.equal(ask('lirias-arcade.local', 'A', '8.8.8.8').length, 0);
  sock.emit('query', null, null);
  on = false;
  assert.equal(ask('lirias-arcade.local', 'A', '192.168.1.40').length, 0);
  on = true;
  const n = sock.sent.length;
  r.stop();
  assert.equal(sock.sent.length, n + 1, 'goodbye sent');
  assert.ok(sock.sent[n].answers.every((a) => a.ttl === 0));
  assert.ok(sock.destroyed);
  assert.deepEqual(addressesFor('192.168.1.5', [{ address: '192.168.1.11', netmask: '255.255.255.0' }]), ['192.168.1.11']);
});

test('Sunshine probe: read-only checks, cached for 10 seconds', async () => {
  let now = 0; let calls = 0;
  const probe = sunshine.createProbe({ now: () => now, checks: { installed: () => { calls++; return false; }, running: () => false, webUi: async () => true } });
  assert.deepEqual(await probe(), { installed: true, running: true, webUi: true }, 'the web page answering means it runs');
  now = 5000; await probe();
  assert.equal(calls, 1);
  now = 11_000; await probe();
  assert.equal(calls, 2);
  const failing = sunshine.createProbe({ checks: { installed: () => { throw new Error('x'); }, running: async () => { throw new Error('y'); }, webUi: () => false } });
  assert.deepEqual(await failing(), { installed: false, running: false, webUi: false });
  assert.ok(sunshine.installPaths({ ProgramFiles: 'C:\\Program Files' }).includes('C:\\Program Files\\Sunshine\\sunshine.exe'));
  // A closed port is "not running", quickly.
  const s = net.createServer(); await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const free = s.address().port; await new Promise((r) => s.close(r));
  assert.equal(await sunshine.portOpen(free), false);
});

test('Sunshine app list: adds Liria\'s Arcade with a backup, safe to run twice, other apps untouched', () => {
  const dir = mkTmp('arcade-sunshine-');
  const file = path.join(dir, 'apps.json');
  const original = { env: { PATH: '$(PATH);$(ProgramFiles(x86))\\Steam' }, apps: [{ name: 'Desktop', 'image-path': 'desktop.png' }, { name: 'Steam Big Picture', detached: ['steam://open/bigpicture'] }] };
  fs.writeFileSync(file, `\uFEFF${JSON.stringify(original, null, 4)}`);
  const root = 'E:\\Projects\\Lirias-Arcade';
  const r1 = sunshineApp.addToFile(file, { root, now: new Date(2026, 10, 28, 3, 4, 5) });
  assert.equal(r1.action, 'added');
  assert.ok(r1.backup.endsWith('apps.json.bak-20261128-030405'));
  assert.equal(fs.readFileSync(r1.backup, 'utf8').replace(/^\uFEFF/, ''), JSON.stringify(original, null, 4), 'the backup is the old file');
  const after1 = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(after1.env, original.env);
  assert.deepEqual(after1.apps.slice(0, 2), original.apps);
  const app = after1.apps[2];
  assert.equal(app.name, "Liria's Arcade");
  assert.deepEqual(app.detached, ['cmd /c "E:\\Projects\\Lirias-Arcade\\Launch-Arcade.bat"']);
  assert.equal(app['working-dir'], root);
  // Twice: nothing written, no second backup, no second entry.
  const before = fs.readFileSync(file, 'utf8');
  const r2 = sunshineApp.addToFile(file, { root, now: new Date(2026, 10, 28, 3, 4, 6) });
  assert.equal(r2.action, 'unchanged');
  assert.equal(r2.backup, null);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(fs.readdirSync(dir).filter((f) => f.includes('.bak-')).length, 1);
  // An older arcade entry is replaced in place, never doubled.
  const old = { ...after1, apps: [after1.apps[0], { name: "Liria's Arcade", cmd: 'old.bat' }, after1.apps[1]] };
  fs.writeFileSync(file, JSON.stringify(old));
  const r3 = sunshineApp.addToFile(file, { root, now: new Date(2026, 10, 28, 3, 5, 0) });
  assert.equal(r3.action, 'updated');
  const after3 = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(after3.apps.map((a) => a.name), ['Desktop', "Liria's Arcade", 'Steam Big Picture']);
  assert.equal(after3.apps[1].cmd, '');
  // Broken JSON or a missing file: never touched.
  fs.writeFileSync(file, '{ "apps": [ broken');
  assert.throws(() => sunshineApp.addToFile(file, { root }), /not valid JSON/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ "apps": [ broken');
  assert.throws(() => sunshineApp.addToFile(path.join(dir, 'missing.json'), { root }), /Install Sunshine first/);
  assert.equal(sunshineApp.defaultAppsPath({ ProgramFiles: 'C:\\Program Files' }), 'C:\\Program Files\\Sunshine\\config\\apps.json');
  // Dry run changes nothing.
  fs.writeFileSync(file, JSON.stringify(original));
  const dry = sunshineApp.addToFile(file, { root, dryRun: true });
  assert.equal(dry.action, 'added');
  assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify(original));
});

test('Set Arcade PIN tool: stores only a scrypt hash, off forgets devices (temp state)', async () => {
  const dir = mkTmp('arcade-setpin-');
  fs.writeFileSync(path.join(dir, 'lan-sessions.json'), '{"sessions":[]}');
  const tool = path.join(__dirname, '..', 'tools', 'set-pin.js');
  const run = (args, input) => spawnSync(process.execPath, [tool, ...args], { input, encoding: 'utf8', env: { ...process.env, ARCADE_STATE_DIR: dir }, timeout: 20000 });
  assert.match(run(['status']).stdout, /OFF/);
  const mismatch = run(['set'], '4321\n1234\n4321\n1234\n4321\n1234\n');
  assert.equal(mismatch.status, 1);
  assert.equal(fs.existsSync(path.join(dir, 'lan.json')), false);
  const set = run(['set'], '864213\n864213\n');
  assert.equal(set.status, 0, set.stdout + set.stderr);
  assert.doesNotMatch(set.stdout, /864213/);
  const saved = fs.readFileSync(path.join(dir, 'lan.json'), 'utf8');
  assert.doesNotMatch(saved, /864213/);
  const rec = JSON.parse(saved);
  assert.equal(rec.enabled, true);
  assert.equal(rec.pin.algo, 'scrypt');
  assert.equal(fs.existsSync(path.join(dir, 'lan-sessions.json')), false, 'a new PIN forgets every device');
  assert.match(run(['status']).stdout, /ON/);
  const a = new lan.LanAuth(dir);
  assert.equal((await a.tryPin('10.9.9.9', '864213')).ok, true);
  assert.equal(run(['off']).status, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'lan.json'), 'utf8')).enabled, false);
  assert.equal(lan.LanAuth.wantsLan(dir), false);
});

test('pages: no em dashes, escaped text, no script anywhere', () => {
  for (const body of [lanPage.pinPage('<x>'), lanPage.offPage(), lanPage.livingRoomPage({ game: { romRunning: true, title: '"><img src=x>' }, sunshine: {}, pcAddress: '192.168.1.11' })]) {
    assert.doesNotMatch(body, /\u2014/);
    assert.doesNotMatch(body, /<script/i);
    assert.doesNotMatch(body, /<img src=x>/);
  }
  assert.match(lanPage.livingRoomPage({ pcAddress: '192.168.1.11' }), /192\.168\.1\.11/);
});
