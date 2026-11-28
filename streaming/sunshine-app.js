'use strict';

// Adds "Liria's Arcade" to Sunshine's app list (apps.json), so Moonlight on the
// Mac can start the arcade. Run by "Add Arcade To Sunshine.bat" (as admin,
// because apps.json lives under Program Files).
//
//   node streaming/sunshine-app.js add [--apps <apps.json>] [--dry-run]
//   node streaming/sunshine-app.js show [--apps <apps.json>]
//
// - The app runs the same launch as double-clicking Launch-Arcade.bat
//   ("detached": Sunshine starts it and does not wait for it).
// - Backs apps.json up first (apps.json.bak-<date>-<time>, beside it), and
//   only when it is about to change it.
// - Safe to run twice: when the entry is already there and the same, nothing
//   is written. An older "Liria's Arcade" entry is replaced, never doubled.
//   Every other app in the list is left exactly as it was.
// - A file that is not valid JSON is never touched.
//
// Exit codes: 0 = added or updated, 10 = already there (nothing changed),
// 1 = error (nothing changed).

const fs = require('fs');
const path = require('path');

const APP_NAME = "Liria's Arcade";
const ROOT = path.resolve(__dirname, '..');

function defaultAppsPath(env = process.env) {
  return path.join(env.ProgramFiles || 'C:\\Program Files', 'Sunshine', 'config', 'apps.json');
}

/** The apps.json entry for the arcade (root = the arcade folder). */
function arcadeApp(root = ROOT) {
  const bat = path.join(root, 'Launch-Arcade.bat');
  return {
    name: APP_NAME,
    output: '',
    cmd: '',
    // cmd /c "<bat>": the same launch as double-clicking Launch-Arcade.bat.
    detached: [`cmd /c "${bat}"`],
    'working-dir': root,
    'image-path': path.join(root, 'frontend', 'assets', 'icon-512.png'),
    'exclude-global-prep-cmd': 'false',
    elevated: 'false',
    'auto-detach': 'true',
  };
}

function sameApp(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Pure: returns { changed, data, action } for a parsed apps.json.
 * action: 'added' | 'updated' | 'unchanged'.
 */
function withArcade(data, app = arcadeApp()) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('apps.json is not a JSON object.');
  if (data.apps !== undefined && !Array.isArray(data.apps)) throw new Error('apps.json has an "apps" entry that is not a list.');
  const apps = Array.isArray(data.apps) ? data.apps : [];
  const idx = apps.findIndex((a) => a && typeof a === 'object' && a.name === APP_NAME);
  if (idx !== -1 && sameApp(apps[idx], app) && apps.filter((a) => a && a.name === APP_NAME).length === 1) {
    return { changed: false, data, action: 'unchanged' };
  }
  const others = apps.filter((a) => !(a && typeof a === 'object' && a.name === APP_NAME));
  const next = idx === -1 ? [...apps, app] : [...others.slice(0, idx), app, ...others.slice(idx)];
  return { changed: true, data: { ...data, apps: next }, action: idx === -1 ? 'added' : 'updated' };
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Reads, backs up, writes. Returns { action, backup }. Throws on any problem (nothing written). */
function addToFile(appsPath, { dryRun = false, root = ROOT, now = new Date() } = {}) {
  if (!fs.existsSync(appsPath)) {
    throw new Error(`Sunshine's app list was not found at ${appsPath}. Install Sunshine first (Install Game Streaming.bat) and open https://localhost:47990 once.`);
  }
  const raw = fs.readFileSync(appsPath, 'utf8');
  let data;
  try { data = JSON.parse(raw.replace(/^\uFEFF/, '')); } catch (err) { throw new Error(`apps.json is not valid JSON, so it was left alone (${err.message}).`); }
  const r = withArcade(data, arcadeApp(root));
  if (!r.changed || dryRun) return { action: r.action, backup: null, dryRun };
  const backup = `${appsPath}.bak-${stamp(now)}`;
  fs.copyFileSync(appsPath, backup, fs.constants.COPYFILE_EXCL);
  const tmp = `${appsPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(r.data, null, 4)}\n`);
  fs.renameSync(tmp, appsPath);
  return { action: r.action, backup };
}

function main(argv) {
  const cmd = argv[0];
  const i = argv.indexOf('--apps');
  const appsPath = i !== -1 && argv[i + 1] ? path.resolve(argv[i + 1]) : defaultAppsPath();
  if (cmd === 'show') {
    console.log(JSON.stringify(arcadeApp(), null, 4));
    return 0;
  }
  if (cmd !== 'add') {
    console.log('Usage: node streaming/sunshine-app.js add [--apps <apps.json>] [--dry-run] | show');
    return 1;
  }
  try {
    const r = addToFile(appsPath, { dryRun: argv.includes('--dry-run') });
    if (r.action === 'unchanged') {
      console.log(`  "${APP_NAME}" is already in Sunshine's app list. Nothing was changed.`);
      return 10;
    }
    if (r.dryRun) {
      console.log(`  Dry run: "${APP_NAME}" would be ${r.action} in ${appsPath}. Nothing was changed.`);
      return 10;
    }
    console.log(`  "${APP_NAME}" was ${r.action} in Sunshine's app list.`);
    console.log(`  The old list was saved as ${r.backup}`);
    return 0;
  } catch (err) {
    console.log(`  NOT CHANGED: ${err.message}`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { arcadeApp, withArcade, addToFile, defaultAppsPath, APP_NAME, main };
