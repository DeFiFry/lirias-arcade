'use strict';

// node --test test/   (npm test). Never launches a game or RetroArch, never
// touches the real state/ folder; every temp folder is removed afterwards.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const { spawn } = require('child_process');
const nowPlayingLib = require('../now-playing');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arcade-np-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function readJson(file) {
  const raw = fs.readFileSync(file);
  assert.notStrictEqual(raw[0], 0xef, 'no BOM');
  return JSON.parse(raw.toString('utf8'));
}

test('start writes contract v1, heartbeat rewrites at, stop deletes', async (t) => {
  const dir = tempDir(t);
  let clock = Date.parse('2026-11-26T20:06:11.000Z');
  const np = nowPlayingLib.create({ stateDir: path.join(dir, 'state'), heartbeatMs: 40, now: () => new Date(clock), log: () => {} });
  np.start({ title: 'Grand Theft Auto: Vice City - Mod', pid: 12345 });
  t.after(() => np.stop());
  const first = readJson(np.nowFile);
  assert.deepStrictEqual(first, {
    v: 1, kind: 'game', state: 'playing', title: 'Grand Theft Auto: Vice City - Mod',
    artist: null, source: null, version: null, pid: 12345,
    since: '2026-11-26T20:06:11.000Z', at: '2026-11-26T20:06:11.000Z', recent: [],
  });
  clock += 30000;
  await new Promise((r) => setTimeout(r, 120));
  const beat = readJson(np.nowFile);
  assert.strictEqual(beat.since, first.since);
  assert.strictEqual(beat.at, '2026-11-26T20:06:41.000Z');
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'state')), ['now-playing.json'], 'no tmp files left');
  np.stop();
  assert.ok(!fs.existsSync(np.nowFile));
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(!fs.existsSync(np.nowFile), 'no heartbeat after stop');
});

test('stop without start never deletes a file another process wrote', (t) => {
  const dir = tempDir(t);
  const np = nowPlayingLib.create({ stateDir: dir, log: () => {} });
  fs.writeFileSync(np.nowFile, '{"v":1}');
  np.stop();
  assert.ok(fs.existsSync(np.nowFile));
});

test('clearLeftover removes an old file and stray tmp files', (t) => {
  const dir = tempDir(t);
  const np = nowPlayingLib.create({ stateDir: dir, log: () => {} });
  fs.writeFileSync(np.nowFile, '{"v":1}');
  fs.writeFileSync(path.join(dir, 'now-playing.json.999.tmp'), '{');
  fs.writeFileSync(path.join(dir, 'keep.txt'), 'x');
  np.clearLeftover();
  assert.deepStrictEqual(fs.readdirSync(dir), ['keep.txt']);
  nowPlayingLib.create({ stateDir: path.join(dir, 'missing'), log: () => {} }).clearLeftover(); // no folder: no throw
});

test('a write that fails never throws and is logged once', (t) => {
  const dir = tempDir(t);
  const blocker = path.join(dir, 'state');
  fs.writeFileSync(blocker, 'a file where the folder should be');
  const logs = [];
  const np = nowPlayingLib.create({ stateDir: blocker, heartbeatMs: 20, log: (m) => logs.push(m) });
  assert.doesNotThrow(() => np.start({ title: 'X', pid: 1 }));
  assert.doesNotThrow(() => np.writeCatalog([{ type: 'rom', system: 'a', title: 'A' }], [{ key: 'a', label: 'A' }]));
  assert.doesNotThrow(() => np.stop());
  assert.strictEqual(logs.filter((m) => m.includes('write')).length, 1);
});

test('catalog: menu order, only menu systems, ROMs only, rewritten only on change', (t) => {
  const dir = tempDir(t);
  const np = nowPlayingLib.create({ stateDir: dir, log: () => {} });
  const order = [{ key: 'genesis', label: 'Sega Genesis' }, { key: 'ps2', label: 'PlayStation 2' }, { key: 'wii', label: 'Wii / GameCube' }];
  const games = [
    { type: 'html5', title: 'Some Html Game', folder: 'x', url: '/games/x/index.html' },
    { type: 'rom', system: 'genesis', title: 'Golden Axe', file: 'ga.md' },
    { type: 'rom', system: 'genesis', title: 'Golden Axe - Mod', file: 'ga mod.md' },
    { type: 'rom', system: 'ps2', title: 'Grand Theft Auto: Vice City - Mod', file: 'Grand Theft Auto Vice City Mod.iso' },
    { type: 'rom', system: 'mame', title: 'Not In The Menu', file: 'nim.zip' },
  ];
  assert.strictEqual(np.writeCatalog(games, order), true);
  const cat = readJson(np.catalogFile);
  assert.strictEqual(cat.v, 1);
  assert.strictEqual(cat.app, 'arcade');
  assert.ok(!Number.isNaN(Date.parse(cat.at)));
  assert.deepStrictEqual(cat.groups, [
    { name: 'Sega Genesis', items: ['Golden Axe', 'Golden Axe - Mod'] },
    { name: 'PlayStation 2', items: ['Grand Theft Auto: Vice City - Mod'] },
  ]);
  assert.ok(!/\.iso|\.md|\/games\//.test(fs.readFileSync(np.catalogFile, 'utf8')), 'no file names or URLs');
  assert.strictEqual(np.writeCatalog(games, order), false, 'same list: not rewritten');
  games.push({ type: 'rom', system: 'wii', title: 'New Game', file: 'n.iso' });
  assert.strictEqual(np.writeCatalog(games, order), true);
  assert.strictEqual(readJson(np.catalogFile).groups.length, 3);
});

test('readMenuOrder reads CATEGORY_ORDER from the real app.js', () => {
  const order = nowPlayingLib.readMenuOrder(path.join(__dirname, '..', 'app.js'));
  assert.ok(order && order.length >= 5);
  assert.deepStrictEqual(order[0], { key: 'atari', label: 'Atari' });
  assert.ok(order.some((o) => o.key === 'ps2' && o.label === 'PlayStation 2'));
  assert.strictEqual(nowPlayingLib.readMenuOrder(path.join(__dirname, 'nope.js')), null);
});

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on('error', reject);
  });
}

function get(port, p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve(JSON.parse(body)));
    }).on('error', reject);
  });
}

// Headless: a second arcade server on a spare port with a temp state folder.
// It reads the real roms/ and titles.json; no game is launched.
test('server: leftover deleted on start, catalog matches /api/games and the menu', async (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'now-playing.json'), '{"v":1,"title":"stale"}');
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(port), ARCADE_STATE_DIR: dir },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  t.after(() => { try { child.kill(); } catch (e) { /* gone */ } });
  const catalogFile = path.join(dir, 'catalog.json');
  for (let i = 0; i < 100 && !fs.existsSync(catalogFile); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(fs.existsSync(catalogFile), 'catalog written on start');
  assert.ok(!fs.existsSync(path.join(dir, 'now-playing.json')), 'leftover removed');
  const cat = readJson(catalogFile);
  const { games } = await get(port, '/api/games');
  const order = nowPlayingLib.readMenuOrder(path.join(__dirname, '..', 'app.js'));
  const expected = order
    .map(({ key, label }) => ({ name: label, items: games.filter((g) => g.system === key).map((g) => g.title) }))
    .filter((g) => g.items.length);
  assert.deepStrictEqual(cat.groups, expected);
  if (process.env.ARCADE_DRY_OUT) fs.copyFileSync(catalogFile, process.env.ARCADE_DRY_OUT);
  const exited = new Promise((r) => child.on('exit', r));
  child.kill();
  await exited;
});
