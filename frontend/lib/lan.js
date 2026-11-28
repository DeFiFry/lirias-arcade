'use strict';

// Home network mode: the arcade's "Living Room" page on another device (Paul's
// Mac in the living room) while the arcade runs on this PC. Copied from Playlist
// Liria's lib/lan.js (itself from Liria Cinema's), with the arcade's own cookie
// name, mDNS name and state files. The games themselves reach the Mac through
// Sunshine and Moonlight (streaming/), never through this page.
//
// - The PC keeps its own listener (port 8080) exactly as before. Only when an
//   Arcade PIN is set does a SECOND listener open for other devices, on its
//   own port (6969, lib/living-room.js); only loopback and private home-network
//   addresses are ever answered there.
// - Every client that is not this PC needs the Arcade PIN once per device; a
//   random session token in an HttpOnly, SameSite=Strict cookie then keeps it
//   signed in for a year.
// - The PIN is set by "Set Arcade PIN.bat" (frontend\tools\set-pin.js), which
//   writes only a salted scrypt hash to state\lan.json. No PIN, no LAN access.
// - Valid sessions live in state\lan-sessions.json (only their SHA-256 hashes).

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Not the cinema's 'liria_lan' or Playlist Liria's 'playlist_liria_lan': cookies
// are not kept apart by port, and the PC's address form (192.168.x.x) is one host
// for all three apps.
const COOKIE = 'lirias_arcade_lan';
const SESSION_DAYS = 365;
const SESSION_MS = SESSION_DAYS * 24 * 3600 * 1000;
const MAX_SESSIONS = 50;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
// Wrong PINs: 5 tries, then a lockout of 1 minute that doubles each time (up to 1 hour).
const FREE_TRIES = 5;
const LOCK_BASE_MS = 60_000;
const LOCK_MAX_MS = 3600_000;
// Across all addresses together: more than 30 wrong PINs in an hour locks every LAN login for 10 minutes,
// and each further trip doubles it (up to a day), so a device that keeps changing its address cannot
// keep guessing at a steady rate. A right PIN, or a new PIN set on the PC, starts it again.
const GLOBAL_MAX = 30;
const GLOBAL_WINDOW_MS = 3600_000;
const GLOBAL_LOCK_MS = 600_000;
const GLOBAL_LOCK_MAX_MS = 24 * 3600_000;

// ---------------------------------------------------------------- addresses --

/** '::ffff:192.168.1.5' -> '192.168.1.5'; strips an IPv6 zone ('%eth0'). */
function normalizeIp(ip) {
  let s = String(ip || '').trim().toLowerCase();
  const pct = s.indexOf('%');
  if (pct !== -1) s = s.slice(0, pct);
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  return m ? m[1] : s;
}

function v4parts(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  return p.every((n) => n <= 255) ? p : null;
}

/** First 16-bit group of an IPv6 address, or null when it is not IPv6. */
function v6first(ip) {
  if (!ip.includes(':')) return null;
  if (ip.startsWith('::')) return 0;
  const g = ip.split(':')[0];
  return /^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : null;
}

function isLoopback(raw) {
  const ip = normalizeIp(raw);
  const v4 = v4parts(ip);
  if (v4) return v4[0] === 127;
  return ip === '::1' || ip === '0:0:0:0:0:0:0:1';
}

/** Loopback, 10/8, 172.16/12, 192.168/16, 169.254/16, fe80::/10, fc00::/7 (fd00::/8 in practice), ::1. */
function isPrivate(raw) {
  const ip = normalizeIp(raw);
  if (isLoopback(ip)) return true;
  const v4 = v4parts(ip);
  if (v4) {
    const [a, b] = v4;
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  const g = v6first(ip);
  if (g === null || ip.startsWith('::')) return false; // '::' forms other than ::1 (mapped, unspecified) are not trusted
  return (g & 0xffc0) === 0xfe80 || (g & 0xfe00) === 0xfc00;
}

/** This PC's own home-network IPv4 addresses (private, not loopback). */
function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal && isPrivate(i.address) && !isLoopback(i.address)) out.push(i.address);
    }
  }
  return out;
}

/** Same, with each address's netmask (for picking the one on the asker's own subnet). */
function lanInterfaces() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal && isPrivate(i.address) && !isLoopback(i.address)) out.push({ address: i.address, netmask: i.netmask });
    }
  }
  return out;
}

/** The name Liria's Arcade answers to on the home network (mDNS, lib/mdns.js). */
const MDNS_NAME = 'lirias-arcade.local';

/** The address to show Paul: a 192.168/10/172 one first, link-local (169.254) last. */
function preferredAddresses() {
  const all = lanAddresses();
  return [...all.filter((a) => !a.startsWith('169.254.')), ...all.filter((a) => a.startsWith('169.254.'))];
}

function hostName() {
  return String(os.hostname() || '').toLowerCase();
}

// Host header allowlist, rebuilt at most every 30 s (a new DHCP address works without a restart).
let hostCache = { at: 0, port: 0, set: null };
function allowedHosts(port) {
  const now = Date.now();
  if (hostCache.set && hostCache.port === port && now - hostCache.at < 30_000) return hostCache.set;
  const names = ['127.0.0.1', 'localhost', '[::1]', MDNS_NAME];
  const h = hostName();
  if (/^[a-z0-9-]+$/.test(h)) names.push(h, `${h}.local`);
  names.push(...lanAddresses());
  const set = new Set(names.map((n) => `${n}:${port}`));
  if (port === 80) names.forEach((n) => set.add(n));
  hostCache = { at: now, port, set };
  return set;
}

// ---------------------------------------------------------------- the PIN ---

function scrypt(pin, salt, params = SCRYPT) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(pin), salt, params.keylen, { N: params.N, r: params.r, p: params.p, maxmem: 64 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

const PIN_RE = /^[0-9]{4,8}$/;

/** What "Set Arcade PIN.bat" stores: a salted scrypt hash, never the PIN. */
async function makePinRecord(pin) {
  if (!PIN_RE.test(String(pin))) throw new Error('The PIN must be 4 to 8 digits.');
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(pin, salt);
  return { algo: 'scrypt', N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, keylen: SCRYPT.keylen, salt: salt.toString('hex'), hash: hash.toString('hex') };
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`[lan] ${path.basename(file)} ignored:`, err.message);
    return null;
  }
}

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    const k = part.slice(0, i).trim();
    if (k && !(k in out)) out[k] = part.slice(i + 1).trim();
  }
  return out;
}

class LanAuth {
  /** stateDir holds lan.json (PIN, written by the bat) and lan-sessions.json (written here). */
  constructor(stateDir, { now = () => Date.now() } = {}) {
    this.configFile = path.join(stateDir, 'lan.json');
    this.sessionsFile = path.join(stateDir, 'lan-sessions.json');
    this.now = now;
    this.config = null;
    this.configStamp = null;
    this.sessions = new Map(); // sha256(token) -> { pin, created, seen }
    this.saveTimer = null;
    this.fails = new Map(); // ip -> { count, locks, until }
    this.globalFails = [];
    this.globalUntil = 0;
    this.globalLocks = 0;
    this.dirty = false; // sessions changed since the last save
    this.checking = new Set(); // addresses with a PIN check running now
    this._loadConfig(true);
    const s = readJson(this.sessionsFile);
    if (s && Array.isArray(s.sessions) && this.config.enabled) {
      for (const x of s.sessions) {
        if (x && /^[0-9a-f]{64}$/.test(x.h) && x.pin === this.config.pin.salt) this.sessions.set(x.h, { pin: x.pin, created: Number(x.created) || 0, seen: Number(x.seen) || 0 });
      }
    }
  }

  /** Re-reads state\lan.json when it changed, so turning the mode off works at once. */
  _loadConfig(force = false) {
    let stamp = null;
    try { const st = fs.statSync(this.configFile); stamp = `${st.mtimeMs}:${st.size}`; } catch (_) { stamp = 'none'; }
    if (!force && stamp === this.configStamp) return;
    this.configStamp = stamp;
    const c = stamp === 'none' ? null : readJson(this.configFile);
    const pin = c && c.pin;
    const valid = pin && pin.algo === 'scrypt' && /^[0-9a-f]{32,}$/.test(pin.salt) && /^[0-9a-f]{64}$/.test(pin.hash)
      && Number.isInteger(pin.N) && pin.N >= 1024 && pin.N <= 1048576 && Number.isInteger(pin.r) && Number.isInteger(pin.p) && pin.keylen === 32;
    this.config = { enabled: Boolean(c && c.enabled === true && valid), pin: valid ? pin : null };
    // A new PIN, or the mode turned off, forgets every remembered device (set-pin.js also deletes the file).
    if (!force) {
      let dropped = false;
      for (const [h, s] of this.sessions) {
        if (!this.config.enabled || s.pin !== this.config.pin.salt) { this.sessions.delete(h); dropped = true; }
      }
      if (dropped) this.saveNow();
      // A new PIN (or the mode turned off) is the PC re-arming LAN logins: every lockout starts again.
      this.fails.clear();
      this.globalFails = [];
      this.globalUntil = 0;
      this.globalLocks = 0;
    }
  }

  /** True when a PIN is set and home network mode is on. */
  enabled() {
    this._loadConfig();
    return this.config.enabled;
  }

  /** Whether lan.json asked for the LAN at start-up (decides which address the server listens on). */
  static wantsLan(stateDir) {
    const a = new LanAuth(stateDir);
    return a.config.enabled;
  }

  // ---- sessions ----
  sessionValid(req) {
    if (!this.enabled()) return false;
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
    const h = sha256(token);
    const s = this.sessions.get(h);
    if (!s || s.pin !== this.config.pin.salt) return false;
    const now = this.now();
    if (now - s.seen > SESSION_MS) { this.sessions.delete(h); this._saveSoon(); return false; }
    if (now - s.seen > 3600_000) { s.seen = now; this._saveSoon(); }
    return true;
  }

  _newSession() {
    const token = crypto.randomBytes(32).toString('base64url');
    const now = this.now();
    this.sessions.set(sha256(token), { pin: this.config.pin.salt, created: now, seen: now });
    // Keep the newest MAX_SESSIONS, and drop any made under an older PIN.
    for (const [h, s] of this.sessions) if (s.pin !== this.config.pin.salt) this.sessions.delete(h);
    if (this.sessions.size > MAX_SESSIONS) {
      const oldest = [...this.sessions.entries()].sort((a, b) => a[1].seen - b[1].seen);
      for (const [h] of oldest.slice(0, this.sessions.size - MAX_SESSIONS)) this.sessions.delete(h);
    }
    this._saveSoon();
    return token;
  }

  cookieHeader(token) {
    return `${COOKIE}=${token}; Path=/; Max-Age=${SESSION_DAYS * 24 * 3600}; HttpOnly; SameSite=Strict`;
  }

  _saveSoon() {
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.saveNow(); }, 500);
    if (this.saveTimer.unref) this.saveTimer.unref();
  }

  saveNow() {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    this.dirty = false;
    try {
      writeJsonAtomic(this.sessionsFile, { sessions: [...this.sessions.entries()].map(([h, s]) => ({ h, ...s })) });
    } catch (err) {
      console.error('[lan] could not save sessions:', err.message);
    }
  }

  // ---- wrong-PIN limits ----
  /** Milliseconds this address must still wait before trying again (0 = may try). */
  lockedFor(ip) {
    const now = this.now();
    const g = Math.max(0, this.globalUntil - now);
    const f = this.fails.get(ip);
    return Math.max(g, f ? Math.max(0, f.until - now) : 0);
  }

  triesLeft(ip) {
    const f = this.fails.get(ip);
    return f ? Math.max(0, FREE_TRIES - f.count) : FREE_TRIES;
  }

  _fail(ip) {
    const now = this.now();
    const f = this.fails.get(ip) || { count: 0, locks: 0, until: 0 };
    f.count += 1;
    if (f.count >= FREE_TRIES) {
      f.until = now + Math.min(LOCK_MAX_MS, LOCK_BASE_MS * 2 ** f.locks);
      f.locks += 1;
      f.count = 0;
    }
    this.fails.set(ip, f);
    this.globalFails = this.globalFails.filter((t) => now - t < GLOBAL_WINDOW_MS);
    this.globalFails.push(now);
    if (this.globalFails.length > GLOBAL_MAX) {
      this.globalUntil = now + Math.min(GLOBAL_LOCK_MAX_MS, GLOBAL_LOCK_MS * 2 ** this.globalLocks);
      this.globalLocks += 1;
      this.globalFails = [];
    }
    if (this.fails.size > 1000) this.fails.delete(this.fails.keys().next().value);
  }

  /**
   * Checks a PIN typed on the LAN page. Resolves with
   * { ok: true, token } or { ok: false, reason: 'off' | 'locked' | 'wrong' | 'busy', wait?, left? }.
   */
  async tryPin(ip, pin) {
    if (!this.enabled()) return { ok: false, reason: 'off' };
    const wait = this.lockedFor(ip);
    if (wait > 0) return { ok: false, reason: 'locked', wait };
    // One check at a time per address and a few in all: a flood of parallel
    // guesses can neither slip past the counter nor eat memory (scrypt uses 16 MB each).
    if (this.checking.has(ip) || this.checking.size >= 4) return { ok: false, reason: 'busy' };
    this.checking.add(ip);
    const rec = this.config.pin;
    const typed = String(pin == null ? '' : pin).slice(0, 64);
    let got;
    try {
      // Always hash (even a badly formed entry), so every wrong answer takes the same time.
      got = await scrypt(typed, Buffer.from(rec.salt, 'hex'), rec);
    } finally {
      this.checking.delete(ip);
    }
    const ok = crypto.timingSafeEqual(got, Buffer.from(rec.hash, 'hex')) && PIN_RE.test(typed);
    // The PIN may have been changed, or the mode turned off, while scrypt ran: an
    // answer for the old PIN never makes a session under the new one.
    if (!this.enabled() || !this.config.pin || this.config.pin.salt !== rec.salt) return { ok: false, reason: 'off' };
    if (!ok) {
      this._fail(ip);
      const w = this.lockedFor(ip);
      return w > 0 ? { ok: false, reason: 'locked', wait: w } : { ok: false, reason: 'wrong', left: this.triesLeft(ip) };
    }
    this.fails.delete(ip);
    this.globalLocks = 0;
    return { ok: true, token: this._newSession() };
  }
}

module.exports = {
  LanAuth, makePinRecord, isPrivate, isLoopback, normalizeIp, lanAddresses, lanInterfaces, preferredAddresses, MDNS_NAME, hostName, allowedHosts, parseCookies,
  writeJsonAtomic, readJson, COOKIE, PIN_RE,
};
