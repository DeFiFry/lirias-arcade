'use strict';

// Small state files for Amarin's activity report (hotel-liria Activity tab,
// docs/PLAN-ACTIVITY-NOW-PLAYING.md section 4.1). Read-only for everyone else.
//
//   state/now-playing.json  the RetroArch game running right now (contract v1),
//                           rewritten every 30 s, deleted when it ends
//   state/catalog.json      every game the arcade menu offers, by system
//
// Nothing here may ever throw into, or slow down, a game launch: every write
// is wrapped, a failure is logged once per kind and then ignored.
// Labels only: no file paths, no URLs, no ROM file names.

const fs = require('fs');
const path = require('path');

const HEARTBEAT_MS = 30 * 1000;

function create(options = {}) {
  const stateDir = options.stateDir || path.join(__dirname, '..', 'state');
  const nowFile = path.join(stateDir, 'now-playing.json');
  const catalogFile = path.join(stateDir, 'catalog.json');
  const heartbeatMs = options.heartbeatMs || HEARTBEAT_MS;
  const now = options.now || (() => new Date());
  const log = options.log || ((msg) => console.error(msg));

  const warned = new Set();
  function warnOnce(kind, err) {
    if (warned.has(kind)) return;
    warned.add(kind);
    try { log(`[now-playing] ${kind} failed (ignored from now on): ${err && err.message}`); } catch (e) { /* never */ }
  }

  // tmp file + rename, so a reader never sees half a file. UTF-8, no BOM.
  function writeJson(file, data, kind) {
    try {
      fs.mkdirSync(stateDir, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
      try {
        fs.renameSync(tmp, file);
      } catch (err) {
        // Windows can refuse a rename over a file a reader has open right now.
        try { fs.renameSync(tmp, file); } catch (err2) {
          try { fs.unlinkSync(tmp); } catch (e) { /* gone already */ }
          throw err2;
        }
      }
      return true;
    } catch (err) {
      warnOnce(kind, err);
      return false;
    }
  }

  function unlink(file, kind) {
    try { fs.unlinkSync(file); } catch (err) { if (err.code !== 'ENOENT') warnOnce(kind, err); }
  }

  // ---- now-playing.json ----
  let current = null; // { title, pid, since }
  let timer = null;

  function record() {
    return {
      v: 1,
      kind: 'game',
      state: 'playing',
      title: current.title,
      artist: null,
      source: null,
      version: null,
      pid: current.pid,
      since: current.since,
      at: now().toISOString(),
      recent: [],
    };
  }

  function stopTimer() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  function start({ title, pid }) {
    try {
      stopTimer();
      current = { title: String(title || ''), pid: Number.isInteger(pid) ? pid : null, since: now().toISOString() };
      writeJson(nowFile, record(), 'write');
      timer = setInterval(() => {
        try { if (current) writeJson(nowFile, record(), 'heartbeat'); } catch (err) { warnOnce('heartbeat', err); }
      }, heartbeatMs);
      if (timer.unref) timer.unref();
    } catch (err) {
      warnOnce('start', err);
    }
  }

  // The game ended (or the server is stopping). Only removes what this
  // process wrote, so a second server that failed to start (port in use)
  // never deletes the running server's file.
  function stop() {
    try {
      stopTimer();
      if (!current) return;
      current = null;
      unlink(nowFile, 'remove');
    } catch (err) {
      warnOnce('stop', err);
    }
  }

  // On server start: a file left behind by a crash belongs to nobody now.
  function clearLeftover() {
    try {
      unlink(nowFile, 'cleanup');
      for (const name of fs.existsSync(stateDir) ? fs.readdirSync(stateDir) : []) {
        if (/^(now-playing|catalog)\.json\.\d+\.tmp$/.test(name)) unlink(path.join(stateDir, name), 'cleanup');
      }
    } catch (err) {
      warnOnce('cleanup', err);
    }
  }

  // ---- catalog.json ----
  let lastCatalogKey = null;

  // games: the same sorted list /api/games returns. order: the menu's
  // categories [{ key, label }] in menu order. Only games the menu shows.
  function buildCatalog(games, order) {
    const groups = [];
    for (const { key, label } of order) {
      const items = games.filter((g) => g && g.type === 'rom' && g.system === key).map((g) => String(g.title));
      if (items.length) groups.push({ name: label, items });
    }
    return groups;
  }

  // Writes only when the list changed (or on the first call).
  function writeCatalog(games, order) {
    try {
      const groups = buildCatalog(games, order);
      const key = JSON.stringify(groups);
      if (key === lastCatalogKey) return false;
      const ok = writeJson(catalogFile, { v: 1, app: 'arcade', at: now().toISOString(), groups }, 'catalog');
      if (ok) lastCatalogKey = key;
      return ok;
    } catch (err) {
      warnOnce('catalog', err);
      return false;
    }
  }

  return { start, stop, clearLeftover, buildCatalog, writeCatalog, nowFile, catalogFile, get current() { return current; } };
}

// The arcade menu's categories, read from CATEGORY_ORDER in app.js so the
// catalog always matches what the menu shows (one list, not two).
function readMenuOrder(appJsPath) {
  try {
    const src = fs.readFileSync(appJsPath, 'utf8');
    const block = src.match(/const CATEGORY_ORDER = \[([\s\S]*?)\];/);
    if (!block) return null;
    const order = [];
    const re = /\{\s*key:\s*'([^']+)',\s*label:\s*'([^']+)'\s*\}/g;
    let m;
    while ((m = re.exec(block[1]))) order.push({ key: m[1], label: m[2] });
    return order.length ? order : null;
  } catch (err) {
    return null;
  }
}

module.exports = { create, readMenuOrder, HEARTBEAT_MS };
