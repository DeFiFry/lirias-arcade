'use strict';

// Arcade PIN for home network mode, run by "Set Arcade PIN.bat".
// The same tool as Playlist Liria's scripts/set-pin.js, for Liria's Arcade.
//
//   node tools/set-pin.js set      ask for a new 4-8 digit PIN twice (hidden), turn the mode on
//   node tools/set-pin.js off      turn home network mode off
//   node tools/set-pin.js status   say whether it is on
//
// Only a salted scrypt hash is written (state\lan.json). The PIN itself is
// never shown, logged or stored. A new PIN, or turning the mode off, forgets
// every remembered device (state\lan-sessions.json is deleted), so each
// device has to type the new PIN.

const fs = require('fs');
const path = require('path');
const { makePinRecord, writeJsonAtomic, readJson, PIN_RE } = require('../lib/lan');

const STATE = path.resolve(process.env.ARCADE_STATE_DIR || path.join(__dirname, '..', '..', 'state'));
const CONFIG = path.join(STATE, 'lan.json');
const SESSIONS = path.join(STATE, 'lan-sessions.json');

function forgetDevices() {
  try { fs.rmSync(SESSIONS, { force: true }); } catch (_) { /* nothing to forget */ }
}

let pipeBuf = '';

/** Reads one line without showing it (a * per digit). Digits only. */
function askHidden(prompt) {
  return new Promise((resolve, reject) => {
    const { stdin, stdout } = process;
    stdout.write(prompt);
    if (!stdin.isTTY) {
      // Not a console (piped): read a line, still never echoed by us.
      const take = () => {
        const i = pipeBuf.search(/\r?\n/);
        if (i === -1) return false;
        const line = pipeBuf.slice(0, i);
        pipeBuf = pipeBuf.slice(i + 1).replace(/^\n/, '');
        stdin.removeListener('data', onData);
        stdin.removeListener('end', onEnd);
        stdin.pause();
        stdout.write('\n');
        resolve(line.replace(/\r$/, ''));
        return true;
      };
      const onData = (d) => { pipeBuf += String(d); take(); };
      const onEnd = () => { if (!take()) reject(new Error('cancelled')); };
      if (take()) return;
      stdin.on('data', onData);
      stdin.on('end', onEnd);
      stdin.resume();
      return;
    }
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const done = (err) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onKey);
      stdout.write('\n');
      if (err) reject(err); else resolve(value);
    };
    function onKey(chunk) {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done();
        if (ch === '\u0003' || ch === '\u001b') return done(new Error('cancelled'));
        if (ch === '\b' || ch === '\u007f') {
          if (value.length) { value = value.slice(0, -1); stdout.write('\b \b'); }
        } else if (/[0-9]/.test(ch) && value.length < 8) {
          value += ch;
          stdout.write('*');
        }
      }
      return undefined;
    }
    stdin.on('data', onKey);
  });
}

async function setPin() {
  for (let attempt = 0; attempt < 3; attempt++) {
    const a = await askHidden('  Type a new Arcade PIN (4 to 8 digits): ');
    if (!PIN_RE.test(a)) { console.log('  The PIN must be 4 to 8 digits. Try again.\n'); continue; }
    const b = await askHidden('  Type it again: ');
    if (a !== b) { console.log('  The two PINs were different. Try again.\n'); continue; }
    const pin = await makePinRecord(a);
    writeJsonAtomic(CONFIG, { enabled: true, pin, updated: new Date().toISOString() });
    forgetDevices();
    console.log('\n  Arcade PIN saved (only a scrambled copy is kept, never the PIN itself).');
    console.log('  Every device that was remembered must type the new PIN.');
    return 0;
  }
  console.log('\n  No PIN was saved.');
  return 1;
}

function off() {
  // The old PIN's hash goes too: turning it on again always means choosing a PIN.
  writeJsonAtomic(CONFIG, { enabled: false, updated: new Date().toISOString() });
  forgetDevices();
  console.log('  The arcade on the home network is now OFF. Every remembered device is forgotten.');
  return 0;
}

function status() {
  const c = readJson(CONFIG);
  console.log(c && c.enabled && c.pin ? '  The arcade on the home network is ON (an Arcade PIN is set).' : '  The arcade on the home network is OFF.');
  return 0;
}

(async () => {
  const cmd = process.argv[2];
  try {
    if (cmd === 'set') process.exitCode = await setPin();
    else if (cmd === 'off') process.exitCode = off();
    else if (cmd === 'status') process.exitCode = status();
    else { console.log('Usage: node tools/set-pin.js set | off | status'); process.exitCode = 2; }
  } catch (err) {
    console.log(err.message === 'cancelled' ? '\n  Cancelled. Nothing was changed.' : `\n  Something went wrong: ${err.message}`);
    process.exitCode = 1;
  }
})();
