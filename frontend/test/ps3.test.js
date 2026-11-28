'use strict';

// PlayStation 3 (RPCS3): the rom-folder scan, the boot target and the RPCS3
// command line (lib/ps3.js), then a TEST COPY of server.js on a spare port
// with a temp rom folder and a stand-in "RPCS3" (node itself, which exits at
// once on the unknown --no-gui option), so the real RPCS3 never opens and the
// running arcade, its port 8080, roms\ and state\ are never touched.
// Every temp folder is deleted when the test ends.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const ps3 = require('../lib/ps3');

const FRONTEND = path.join(__dirname, '..');

function tempDir(t, label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `arcade-ps3-${label}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(file, text = 'x') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

// A rom folder with every kind of entry the PS3 scan has to sort out.
function makePs3Folder(root) {
  const dir = path.join(root, 'ps3');
  write(path.join(dir, 'Demon\'s Souls (USA).iso'));
  write(path.join(dir, 'Upper Case.ISO'));
  write(path.join(dir, 'Uncharted (BCUS98103)', 'PS3_GAME', 'USRDIR', 'EBOOT.BIN'));
  write(path.join(dir, 'Uncharted (BCUS98103)', 'PS3_GAME', 'PARAM.SFO'));
  write(path.join(dir, 'PSN Game', 'USRDIR', 'EBOOT.BIN'));
  write(path.join(dir, 'Half Copied', 'PS3_GAME', 'USRDIR', 'data.bin'));
  write(path.join(dir, 'PS3UPDAT.PUP'));
  write(path.join(dir, 'readme.txt'));
  write(path.join(dir, '.gitkeep'), '');
  return dir;
}

test('scanEntries lists .iso files and game folders only', (t) => {
  const dir = makePs3Folder(tempDir(t, 'scan'));
  assert.deepEqual(ps3.scanEntries(dir, ['.iso']), [
    'Demon\'s Souls (USA).iso',
    'PSN Game',
    'Uncharted (BCUS98103)',
    'Upper Case.ISO',
  ]);
  assert.deepEqual(ps3.scanEntries(path.join(dir, 'missing')), []);
});

test('bootTarget gives the iso itself or the folder EBOOT.BIN', (t) => {
  const dir = makePs3Folder(tempDir(t, 'target'));
  assert.equal(ps3.bootTarget(path.join(dir, 'Demon\'s Souls (USA).iso')), path.join(dir, 'Demon\'s Souls (USA).iso'));
  assert.equal(ps3.bootTarget(path.join(dir, 'Uncharted (BCUS98103)')), path.join(dir, 'Uncharted (BCUS98103)', 'PS3_GAME', 'USRDIR', 'EBOOT.BIN'));
  assert.equal(ps3.bootTarget(path.join(dir, 'PSN Game')), path.join(dir, 'PSN Game', 'USRDIR', 'EBOOT.BIN'));
  assert.equal(ps3.bootTarget(path.join(dir, 'Half Copied')), null);
  assert.equal(ps3.bootTarget(path.join(dir, 'PS3UPDAT.PUP')), null);
  assert.equal(ps3.bootTarget(path.join(dir, 'nothing.iso')), null);
});

test('buildArgs: no GUI, full screen, optional input profile, target last', () => {
  assert.deepEqual(ps3.buildArgs({ target: 'E:\\g\\a b.iso' }), ['--no-gui', '--fullscreen', 'E:\\g\\a b.iso']);
  assert.deepEqual(ps3.buildArgs({ target: 'x/EBOOT.BIN', inputConfig: 'DualSense' }), ['--no-gui', '--fullscreen', '--input-config', 'DualSense', 'x/EBOOT.BIN']);
  assert.throws(() => ps3.buildArgs({}));
});

test('config.json: PS3 sits right after PS2, labelled PlayStation 3, in RPCS3', () => {
  const config = JSON.parse(fs.readFileSync(path.join(FRONTEND, 'config.json'), 'utf8'));
  const keys = Object.keys(config.systems);
  assert.equal(keys.indexOf('ps3'), keys.indexOf('ps2') + 1);
  assert.equal(config.systems.ps3.label, 'PlayStation 3');
  assert.equal(config.systems.ps3.emulator, 'rpcs3');
  const order = require('../now-playing').readMenuOrder(path.join(FRONTEND, 'app.js'));
  const menuKeys = order.map((o) => o.key);
  assert.equal(menuKeys.indexOf('ps3'), menuKeys.indexOf('ps2') + 1);
  assert.equal(order.find((o) => o.key === 'ps3').label, 'PlayStation 3');
});

// ---- the server itself ----

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

function req(method, port, url, body) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: url, method, agent: false, headers: body ? { 'Content-Type': 'application/json' } : {} }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, json });
      });
    });
    r.on('error', reject);
    r.setTimeout(10000, () => r.destroy(new Error('timeout')));
    r.end(body ? JSON.stringify(body) : undefined);
  });
}

async function startCopy(t, env) {
  const port = await freePort();
  const lanPort = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: FRONTEND,
    env: { ...process.env, PORT: String(port), ARCADE_LAN_PORT: String(lanPort), ARCADE_TEST_NO_FOCUS: '1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const exited = new Promise((r) => child.once('exit', r));
  t.after(async () => { if (child.exitCode === null) { child.kill(); await exited; } });
  const deadline = Date.now() + 20000;
  for (;;) {
    try { if ((await req('GET', port, '/api/status')).status === 200) break; } catch { /* not yet */ }
    if (Date.now() > deadline) throw new Error(`test copy did not start:\n${out}`);
    await new Promise((r) => setTimeout(r, 150));
  }
  return port;
}

test('server: PS3 games are listed, launched in "RPCS3" and hand the menu back when it closes', async (t) => {
  const roms = tempDir(t, 'roms');
  makePs3Folder(roms);
  write(path.join(roms, 'snes', 'Some Game (USA).sfc'));
  const stateDir = tempDir(t, 'state');
  const port = await startCopy(t, { ARCADE_ROMS_DIR: roms, ARCADE_STATE_DIR: stateDir, ARCADE_RPCS3_PATH: process.execPath });

  const { json } = await req('GET', port, '/api/games');
  const ps3Games = json.games.filter((g) => g.system === 'ps3');
  assert.deepEqual(ps3Games.map((g) => g.file).sort(), ['Demon\'s Souls (USA).iso', 'PSN Game', 'Uncharted (BCUS98103)', 'Upper Case.ISO']);
  for (const g of ps3Games) {
    assert.equal(g.systemLabel, 'PlayStation 3');
    assert.equal(g.id, `rom:ps3:${g.file}`);
  }
  assert.equal(ps3Games.find((g) => g.file === 'Uncharted (BCUS98103)').title, 'Uncharted');
  assert.equal(json.games.filter((g) => g.system === 'snes').length, 1);

  const catalog = JSON.parse(fs.readFileSync(path.join(stateDir, 'catalog.json'), 'utf8'));
  assert.deepEqual(catalog.groups.map((g) => g.name), ['PlayStation 3', 'Super Nintendo']);

  // Not a game: refused, nothing started.
  const bad = await req('POST', port, '/api/launch', { id: 'rom:ps3:Half Copied' });
  assert.equal(bad.status, 404);
  assert.equal((await req('GET', port, '/api/status')).json.romRunning, false);

  // A game folder: "RPCS3" (node) starts, is tracked, exits at once, and the menu gets the pad back.
  const ok = await req('POST', port, '/api/launch', { id: 'rom:ps3:Uncharted (BCUS98103)' });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json, { type: 'rom', launched: true, emulator: 'RPCS3' });
  const deadline = Date.now() + 15000;
  let status;
  do {
    status = (await req('GET', port, '/api/status')).json;
    if (!status.romRunning) break;
    await new Promise((r) => setTimeout(r, 200));
  } while (Date.now() < deadline);
  assert.equal(status.romRunning, false);
  assert.equal(fs.existsSync(path.join(stateDir, 'now-playing.json')), false);
});

test('server: RPCS3 missing gives a clear error, never a crash', async (t) => {
  const roms = tempDir(t, 'roms2');
  makePs3Folder(roms);
  const port = await startCopy(t, { ARCADE_ROMS_DIR: roms, ARCADE_STATE_DIR: tempDir(t, 'state2'), ARCADE_RPCS3_PATH: path.join(roms, 'no-rpcs3.exe') });
  const r = await req('POST', port, '/api/launch', { id: 'rom:ps3:Upper Case.ISO' });
  assert.equal(r.status, 500);
  assert.match(r.json.error, /RPCS3 not found/);
  assert.equal((await req('GET', port, '/api/status')).json.romRunning, false);
});
