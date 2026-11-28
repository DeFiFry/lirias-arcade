'use strict';

// Names Liria's Arcade on the home network: answers mDNS questions for
// lirias-arcade.local with this PC's private IPv4 address, so a Mac (which
// resolves .local names by itself) can bookmark http://lirias-arcade.local:6969.
// Copied from Playlist Liria's lib/mdns.js (itself from Liria Cinema's). All
// three run on this PC in separate node processes: each binds UDP 5353 with
// reuseAddr and answers only its own name.
//
// - Only that one name, only A records, only private home-network addresses
//   (never loopback, never a public address). IPv4 only because the server
//   listens on IPv4 only (0.0.0.0).
// - The address given is the one on the asker's own subnet when there is one
//   (so a virtual adapter's 169.254 address is never handed to the Mac).
// - Questions from anything but a private address are ignored.
// - It answers only while home network mode is on (isOn()), and stops (with a
//   "goodbye", TTL 0) when the server stops.

const lan = require('./lan');

const TTL = 120;

function v4num(ip) {
  const p = String(ip).split('.').map(Number);
  return p.length === 4 && p.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3] : null;
}

function sameSubnet(a, b, mask) {
  const x = v4num(a); const y = v4num(b); const m = v4num(mask);
  if (x === null || y === null || m === null) return false;
  return ((x & m) >>> 0) === ((y & m) >>> 0);
}

/** The private IPv4 address(es) to give an asker at `from`. */
function addressesFor(from, interfaces = lan.lanInterfaces()) {
  const ifs = interfaces.filter((i) => lan.isPrivate(i.address) && !lan.isLoopback(i.address) && v4num(i.address) !== null);
  const near = ifs.filter((i) => sameSubnet(i.address, lan.normalizeIp(from), i.netmask)).map((i) => i.address);
  if (near.length) return near;
  return ifs.map((i) => i.address).filter((a) => !a.startsWith('169.254.'));
}

/**
 * Starts the responder. opts: { name, isOn: () => bool, interfaces: () => [...], factory }.
 * factory defaults to require('multicast-dns'). Returns { stop(), answered: n } or null
 * when multicast-dns is missing or the socket could not be opened.
 */
function startResponder(opts = {}) {
  const name = String(opts.name || lan.MDNS_NAME).toLowerCase();
  const isOn = opts.isOn || (() => true);
  const interfaces = opts.interfaces || (() => lan.lanInterfaces());
  let factory = opts.factory;
  if (!factory) {
    try { factory = require('multicast-dns'); } catch (_) { console.error('[mdns] multicast-dns is not installed: lirias-arcade.local will not resolve.'); return null; }
  }
  let mdns;
  try {
    mdns = factory({ reuseAddr: true, loopback: false });
  } catch (err) {
    console.error('[mdns] could not start:', err.message);
    return null;
  }
  const state = { answered: 0, stopped: false };
  const records = (from, ttl = TTL) => addressesFor(from, interfaces()).map((data) => ({ name, type: 'A', ttl, class: 'IN', flush: true, data }));

  mdns.on('error', (err) => console.error('[mdns]', err.message));
  mdns.on('warning', () => {});
  mdns.on('query', (query, rinfo) => {
    if (state.stopped) return;
    if (!rinfo || !lan.isPrivate(rinfo.address)) return;
    const qs = Array.isArray(query && query.questions) ? query.questions : [];
    const wanted = qs.some((q) => q && String(q.name).toLowerCase() === name && (q.type === 'A' || q.type === 'ANY'));
    // The name first: every mDNS query on the network arrives here, and isOn() looks at a file.
    if (!wanted || !isOn()) return;
    const answers = records(rinfo.address);
    if (!answers.length) return;
    state.answered += 1;
    try { mdns.respond({ answers }); } catch (err) { console.error('[mdns] respond:', err.message); }
  });

  return {
    get answered() { return state.answered; },
    stop() {
      if (state.stopped) return;
      state.stopped = true;
      // Goodbye: tell caches to forget the name now.
      try {
        const answers = records('0.0.0.0', 0);
        if (answers.length) mdns.respond({ answers }, () => { try { mdns.destroy(); } catch (_) { /* closed */ } });
        else mdns.destroy();
      } catch (_) {
        try { mdns.destroy(); } catch (__) { /* closed */ }
      }
    },
  };
}

module.exports = { startResponder, addressesFor, sameSubnet };
