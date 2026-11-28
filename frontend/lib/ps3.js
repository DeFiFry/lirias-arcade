'use strict';

// PlayStation 3 games for the arcade, played in RPCS3 (standalone: RetroArch
// has no PS3 core). Only systems with "emulator": "rpcs3" in config.json use
// this; every other system still goes through RetroArch exactly as before.
//
// A PS3 game in roms/ps3/ is either
//   - a disc image:        roms/ps3/<name>.iso
//   - a decrypted folder:  roms/ps3/<name>/PS3_GAME/USRDIR/EBOOT.BIN
//                          (or <name>/USRDIR/EBOOT.BIN for a PSN-style game)
// RPCS3 boots either straight from its path.

const fs = require('fs');
const path = require('path');

const EBOOT_PATHS = [
  ['PS3_GAME', 'USRDIR', 'EBOOT.BIN'],
  ['USRDIR', 'EBOOT.BIN'],
];

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

// The EBOOT.BIN inside a game folder, or null if it is not a game folder.
function folderEboot(dir) {
  for (const parts of EBOOT_PATHS) {
    const p = path.join(dir, ...parts);
    if (isFile(p)) return p;
  }
  return null;
}

// What RPCS3 should boot for one entry of roms/ps3: the .iso itself, or the
// folder's EBOOT.BIN. null when the entry is neither (or gone).
function bootTarget(entryPath, fileExts = ['.iso']) {
  if (isDir(entryPath)) return folderEboot(entryPath);
  if (isFile(entryPath) && fileExts.includes(path.extname(entryPath).toLowerCase())) return entryPath;
  return null;
}

// The entries of a PS3 rom folder the menu shows, sorted by name: disc images
// with an allowed extension, and folders that hold an EBOOT.BIN. Everything
// else (a firmware PUP, a readme, a half-copied folder) is left out.
function scanEntries(dir, fileExts = ['.iso']) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names
    .filter((name) => !name.startsWith('.'))
    .filter((name) => bootTarget(path.join(dir, name), fileExts) !== null)
    .sort();
}

// The RPCS3 command line: no main window (--no-gui), the game full screen,
// optionally a named input profile from RPCS3's config/input_configs/global/.
function buildArgs({ target, inputConfig } = {}) {
  if (!target) throw new Error('No PS3 boot target');
  const args = ['--no-gui', '--fullscreen'];
  if (inputConfig) args.push('--input-config', String(inputConfig));
  args.push(target);
  return args;
}

module.exports = { folderEboot, bootTarget, scanEntries, buildArgs, EBOOT_PATHS };
