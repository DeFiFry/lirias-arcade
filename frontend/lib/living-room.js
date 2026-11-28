'use strict';

// Home network mode for Liria's Arcade: the "Living Room" page on another
// device (Paul's Mac in the living room). Off by default.
//
// - The arcade's own listener (server.js, port 8080) is never touched by this
//   file. Only when an Arcade PIN is set ("Set Arcade PIN.bat") does this open
//   a SECOND, separate listener on 0.0.0.0:6969, with its own small router: it
//   is not the arcade app, and none of the arcade's routes exist on it.
// - It answers only loopback and private home-network addresses (the socket's
//   own address, never a forwarding header), only under its own Host names
//   (lirias-arcade.local, this PC's name and its LAN addresses, port 6969),
//   and a form post only from its own page (Origin == Host, Sec-Fetch-Site).
// - Other devices type the Arcade PIN once (lib/lan.js: scrypt, timingSafeEqual,
//   lockouts), then a year-long HttpOnly SameSite=Strict cookie
//   (lirias_arcade_lan, only token hashes stored).
// - READ ONLY: the page shows the arcade's status and whether Sunshine looks
//   installed or running, plus the steps for Moonlight. There is no way to
//   launch a game, change a setting, touch a save or stop the arcade from here:
//   every arcade API path answers 403 on this listener, with or without the PIN.
//   The games reach the Mac through Sunshine + Moonlight (streaming/).
// - Before the PIN, only the arcade's tab icons load (an exact list).
// - lirias-arcade.local is announced over mDNS (lib/mdns.js) while it is open
//   and the mode stays on.

const fs = require('fs');
const http = require('http');
const path = require('path');
const lan = require('./lan');
const lanPage = require('./lan-page');
const mdnsLib = require('./mdns');
const sunshine = require('./sunshine');

const LAN_PORT = 6969;
const LAN_HOST = '0.0.0.0';
const FRONTEND = path.join(__dirname, '..');
const ASSETS = path.join(FRONTEND, 'assets');

// The tab icons, which load before the PIN (exact paths only; a ?v= query is
// allowed). Browsers also ask for /favicon.ico and Safari for the Apple touch
// icons by themselves, so those answer with the arcade's own icons.
const ICONS = new Map([
  ['/favicon.ico', ['Liria-Arcade-Icon.ico', 'image/x-icon']],
  ['/assets/Liria-Arcade-Icon.ico', ['Liria-Arcade-Icon.ico', 'image/x-icon']],
  ['/assets/icon-16.png', ['icon-16.png', 'image/png']],
  ['/assets/icon-32.png', ['icon-32.png', 'image/png']],
  ['/assets/icon-48.png', ['icon-48.png', 'image/png']],
  ['/assets/icon-192.png', ['icon-192.png', 'image/png']],
  ['/assets/icon-512.png', ['icon-512.png', 'image/png']],
  ['/apple-touch-icon.png', ['icon-192.png', 'image/png']],
  ['/apple-touch-icon-precomposed.png', ['icon-192.png', 'image/png']],
]);
const MANIFEST = '/site.webmanifest';

// The arcade's own paths: PC only, refused here whatever the PIN.
const PC_ONLY = /^\/(api|games|music)(\/|$)/i;
const LIVING_ROOM_API = '/api/living-room';

/**
 * opts: { stateDir, port, host, mdns, getGame: () => ({ romRunning, title }),
 *         sunshineProbe: () => Promise<{installed, running, webUi}>, peerAddress (tests only) }
 */
function createLivingRoom(opts = {}) {
  const stateDir = opts.stateDir;
  const lanPort = opts.port !== undefined ? opts.port : LAN_PORT;
  const lanHost = opts.host || LAN_HOST;
  const useMdns = opts.mdns !== false;
  const getGame = opts.getGame || (() => ({ romRunning: false, title: null }));
  const probe = opts.sunshineProbe || sunshine.createProbe();
  const peerAddress = opts.peerAddress;
  const lanAuth = new lan.LanAuth(stateDir);

  let server = null;
  let portNow = null;
  let responder = null;
  let closing = false;

  function send(req, res, status, body) {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : text);
  }

  function html(req, res, status, body, extra = {}) {
    res.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      // same-origin, not no-referrer: with no-referrer the browser sends "Origin: null" on the PIN form's POST.
      'X-Frame-Options': 'DENY', 'Content-Security-Policy': lanPage.CSP, 'Referrer-Policy': 'same-origin', ...extra,
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  function file(req, res, full, type) {
    fs.readFile(full, (err, buf) => {
      if (err) return send(req, res, 404, { error: 'Not found' });
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': buf.length, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      return res.end(req.method === 'HEAD' ? undefined : buf);
    });
  }

  function readText(req, limit) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) { const e = new Error('Too much data'); e.code = 'too-large'; reject(e); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  async function status() {
    let game = { romRunning: false, title: null };
    try { const g = getGame() || {}; game = { romRunning: Boolean(g.romRunning), title: g.romRunning && g.title ? String(g.title) : null }; } catch (_) { /* keep none */ }
    let sun = { installed: false, running: false, webUi: false };
    try { sun = await probe(); } catch (_) { /* keep unknown */ }
    return { arcade: 'running', game, sunshine: sun, pcAddress: lan.preferredAddresses()[0] || null };
  }

  /** The PIN page's form: a small urlencoded body, one PIN check (lib/lan.js LanAuth.tryPin). */
  async function pinPost(req, res) {
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/x-www-form-urlencoded') return html(req, res, 415, lanPage.pinPage('Please type the PIN on this page.'));
    let text;
    try { text = await readText(req, 1024); } catch (_) { return undefined; }
    const pin = new URLSearchParams(text).get('pin') || '';
    const r = await lanAuth.tryPin(req.arPeer, pin);
    if (r.ok) {
      res.writeHead(303, { Location: '/', 'Set-Cookie': lanAuth.cookieHeader(r.token), 'Cache-Control': 'no-store' });
      return res.end();
    }
    if (r.reason === 'off') return html(req, res, 503, lanPage.offPage());
    if (r.reason === 'busy') return html(req, res, 429, lanPage.pinPage('One moment, then try again.'));
    if (r.reason === 'locked') {
      const mins = Math.ceil(r.wait / 60000);
      return html(req, res, 429, lanPage.pinPage(`Too many wrong PINs. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`));
    }
    return html(req, res, 401, lanPage.pinPage(`That PIN is not right. ${r.left} ${r.left === 1 ? 'try' : 'tries'} left before a short wait.`));
  }

  async function handle(req, res) {
    try {
      // Who is asking: always the socket's own address. X-Forwarded-For and
      // similar headers are never read (no proxy is trusted).
      const peer = lan.normalizeIp(peerAddress ? peerAddress(req) : req.socket.remoteAddress);
      if (!lan.isPrivate(peer)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'close' });
        return res.end('Forbidden');
      }
      req.arPeer = peer;
      const local = lan.isLoopback(peer);
      // DNS rebinding guard: only this listener's own names and port.
      if (!lan.allowedHosts(portNow).has(String(req.headers.host || '').toLowerCase())) return send(req, res, 421, { error: 'Wrong host' });
      let url;
      try { url = new URL(req.url, `http://${req.headers.host}`); } catch (_) { return send(req, res, 400, { error: 'Bad request' }); }
      const p = url.pathname;
      const read = req.method === 'GET' || req.method === 'HEAD';
      const isPin = p === '/lan/pin';
      // Another site open in the browser never reaches the API or the PIN form.
      const site = String(req.headers['sec-fetch-site'] || '').toLowerCase();
      if ((p.startsWith('/api') || isPin) && site && site !== 'same-origin' && site !== 'none') return send(req, res, 403, { error: 'Not from this page' });
      if (!read) {
        const origin = req.headers.origin;
        if (origin !== undefined && String(origin).toLowerCase() !== `http://${String(req.headers.host || '').toLowerCase()}`) {
          return send(req, res, 403, { error: 'Not from this page' });
        }
      }
      // The arcade's own routes are PC only, with or without the PIN.
      if (PC_ONLY.test(p) && !(read && p === LIVING_ROOM_API)) {
        return send(req, res, 403, { error: "Only on the PC itself. The arcade is played from Moonlight on this device." });
      }
      // The only write on this listener is the PIN form.
      if (!read && !isPin) return send(req, res, 403, { error: 'This page is read only.' });
      if (read && ICONS.has(p)) { const [f, type] = ICONS.get(p); return file(req, res, path.join(ASSETS, f), type); }
      if (read && p === MANIFEST) return file(req, res, path.join(FRONTEND, 'site.webmanifest'), 'application/manifest+json');
      // A device in another room needs the Arcade PIN once (then a cookie). This PC never does.
      if (!local) {
        const data = p.startsWith('/api');
        if (!lanAuth.enabled()) {
          if (read && !data) return html(req, res, 503, lanPage.offPage());
          return send(req, res, 503, { error: 'The arcade on the home network is turned off.' });
        }
        if (isPin && req.method === 'POST') return await pinPost(req, res);
        if (!lanAuth.sessionValid(req)) {
          if (read && !data) return html(req, res, 401, lanPage.pinPage());
          return send(req, res, 401, { error: 'Enter the Arcade PIN first.' });
        }
      }
      if (isPin && req.method === 'POST') { res.writeHead(303, { Location: '/', 'Cache-Control': 'no-store' }); return res.end(); }
      if (read && (p === '/' || p === '/index.html' || p === '/living-room')) return html(req, res, 200, lanPage.livingRoomPage(await status()));
      if (read && p === LIVING_ROOM_API) return send(req, res, 200, await status());
      return send(req, res, 404, { error: 'Not found' });
    } catch (err) {
      console.error('[living-room]', err && err.message);
      if (res.headersSent) { res.destroy(); return undefined; }
      return send(req, res, 500, { error: 'Something went wrong' });
    }
  }

  /**
   * Opens the Living Room listener when home network mode is on (an Arcade PIN
   * is set). Resolves with its port, or null (off, or the port is taken: the
   * arcade on this PC works as usual either way).
   */
  function start() {
    if (closing || server || !lanAuth.enabled()) return Promise.resolve(server ? portNow : null);
    return new Promise((resolve) => {
      const s = http.createServer((req, res) => { handle(req, res); });
      s.once('error', (e) => {
        console.error(e.code === 'EADDRINUSE'
          ? `Port ${lanPort} is already in use, so the arcade's Living Room page is not available. The arcade works as usual on this PC.`
          : `The arcade's Living Room page could not start: ${e.message}`);
        resolve(null);
      });
      s.listen(lanPort, lanHost, () => {
        if (closing) { s.close(); s.closeAllConnections(); resolve(null); return; }
        s.on('error', (e) => console.error(`[living-room] ${e.message}`));
        server = s;
        portNow = s.address().port;
        responder = useMdns && lanHost !== '127.0.0.1' ? mdnsLib.startResponder({ isOn: () => lanAuth.enabled() }) : null;
        resolve(portNow);
      });
    });
  }

  /** Closes the Living Room listener (and says goodbye to lirias-arcade.local). */
  function close() {
    closing = true;
    if (responder) { responder.stop(); responder = null; }
    if (lanAuth.dirty) lanAuth.saveNow();
    if (!server) return Promise.resolve();
    const s = server;
    server = null;
    return new Promise((r) => { s.close(() => r()); s.closeAllConnections(); });
  }

  return {
    start, close, lanAuth,
    get server() { return server; },
    get port() { return portNow; },
    get mdns() { return responder; },
  };
}

module.exports = { createLivingRoom, LAN_PORT, LAN_HOST, ICONS };
