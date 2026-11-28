# Lirias-Arcade

## Adding your games

This repo ships with no game files. Drop your own legally-owned ROMs/games into these folders:

```
roms/
  fbneo/      <- CPS1, CPS2, Neo Geo ROM zips (e.g. mslug.zip)
  mame/       <- MAME ROM zips
  snes/       <- Super Nintendo ROMs (.sfc, .smc)
  genesis/    <- Sega Genesis/Mega Drive ROMs (.md, .bin, .gen)
  n64/        <- Nintendo 64 ROMs (.n64, .z64)
  psx/        <- PlayStation games (.bin/.cue, .chd)
  ps2/        <- PlayStation 2 games (.iso, .chd) - needs the LRPS2 (pcsx2_libretro) core
  PC/         <- ScummVM-supported PC games (see the scummvm_libretro core's docs)

arcade-collection/
  <your-game-folder>/index.html   <- any standalone HTML5/JS game, auto-detected
                                      (optional — create this folder yourself if you want it)
```

The frontend (`frontend/`) scans both `roms/` and `arcade-collection/` on
every page load — just drop files in and refresh the select screen, no
rebuild needed. `arcade-collection/` doesn't exist by default; create it
and add `<game-folder>/index.html` subfolders only if you have your own
standalone HTML5/JS games to include.

## Running it

```
cd frontend
npm install   # already done
npm start     # http://localhost:8080
```

Or double-click `Launch-Arcade.bat` (or the `Liria's Arcade` shortcut). It starts the
server and opens the arcade in its own Chrome window in kiosk mode: it fills the
screen with no browser bars and no "Press F11 to exit full screen" notice.

To leave the arcade, use its own Exit button (it also stops the server), or
Alt+F4 to close the window. The Windows key or Alt+Tab switch to other windows
while it keeps running. Launching it again while it is open brings the same
window back to the front.

## Living room (home network)

Play the arcade on the living-room Mac: the games still run here in RetroArch/PCSX2,
**Sunshine** on this PC streams the picture and sound to **Moonlight** on the Mac, and the
controller (paired with the Mac by Bluetooth) comes back through Moonlight as an Xbox 360
pad (Sunshine's ViGEmBus driver). Paul's step-by-step guide is
[docs/living-room-arcade.md](docs/living-room-arcade.md); the streaming files are in
`streaming/` (`Install Game Streaming.bat`, `Add Arcade To Sunshine.bat`).

The arcade on this PC does not change: same window, same port (8080), never a PIN.

**Living Room page** (optional, off by default): http://lirias-arcade.local:6969 shows the
arcade's status, whether Sunshine looks installed or running, and the Moonlight steps.

1. Run **`Set Arcade PIN.bat`** here: 1 sets or changes the PIN (4 to 8 digits, typed as
   stars; only a scrambled copy goes into `state/lan.json`), 2 turns it off, 3 cancels.
   Changing the PIN or turning it off forgets every remembered device at once.
2. It then runs **`Allow Arcade On Home Network.bat`**: Windows asks once (press Yes) to let
   Node.js receive TCP 6969 and UDP 5353 on **Private** (home) networks only. The rules are
   named "Liria's Arcade (home network, ...)", separate from Liria Cinema's and Playlist
   Liria's. Port 8080 is never opened.
3. Restart the arcade (EXIT, then the shortcut), open the address on the Mac, type the PIN
   once; that browser is remembered for a year.

How it is kept safe (`frontend/lib/living-room.js`, `lan.js`, `lan-page.js`, `mdns.js`,
`sunshine.js`; the same approach as Playlist Liria's and Liria Cinema's home network mode):

- With a PIN set, a **second, separate listener** opens on 0.0.0.0:6969. It is not the arcade
  app: it has its own small router and none of the arcade's routes. Every arcade path
  (`/api/games`, `/api/launch`, `/api/shutdown`, `/api/status`, `/games/`, `/music/`) answers
  **403** there, with or without the PIN. **Read only:** no launching, settings or saves from
  another device. Without a PIN nothing listens on 6969 at all.
- It answers only this PC and private home-network addresses (the connection itself, never
  forwarding headers), only the names `lirias-arcade.local`, this PC's name and its LAN
  addresses on port 6969 (blocks DNS rebinding), and the PIN form only from its own page
  (Origin must equal Host, Sec-Fetch-Site checked).
- Other devices see a PIN page first (no script at all). The right PIN gives an HttpOnly,
  SameSite=Strict cookie (`lirias_arcade_lan`) for a year; only SHA-256 hashes of the tokens
  are stored (`state/lan-sessions.json`). The PIN is checked with scrypt and
  `timingSafeEqual`. Wrong PINs: 5 tries, then a wait of 1 minute that doubles each time (up
  to an hour), plus a growing limit across all devices, and only a few checks at once.
- Before the PIN only the arcade's tab icons load (an exact list, including `/favicon.ico`
  and the Apple touch icons browsers ask for by themselves).
- `lirias-arcade.local` is announced over mDNS only while the mode is on, only with this
  PC's home-network address, sharing UDP 5353 (reuseAddr) with Liria Cinema's and Playlist
  Liria's responders.
- Sunshine is detected read-only: `sunshine.exe` in Program Files, a running `sunshine.exe`
  process, or something answering on 127.0.0.1:47990 (checked at most every 10 s).
- Tests: `cd frontend && npm test` (`test/lan.test.js`, and `test/pc-unchanged.test.js`, which
  starts a test copy of `server.js` on spare ports with a temp state folder and checks the PC
  routes, the no-PIN case and the PIN case).

## RetroArch setup (required for ROM games)

Edit `frontend/config.json`:
- `retroarchPath` — path to your `retroarch` executable (or just `"retroarch"` if it's on PATH)
- `coresDir` — folder containing your libretro core files (`.dll` on Windows)
- `systems.<name>.core` — libretro core short name to use per system (defaults are reasonable guesses; change if you use a different core, e.g. `mame_libretro` instead of `mame2003_plus_libretro`)

A starter `retroarch.cfg` is at the project root: keyboard fallback on port 1,
gamepad autodetect on ports 1-4 (up to 4 controllers, auto-assigned in
connection order). Copy/merge it into your RetroArch config directory.

## BIOS files (PlayStation, PS2 and Dreamcast)

`bios/` ships empty of BIOS dumps (no BIOS files are included in this repo).
For the `pcsx_rearmed` core to run PlayStation games, source your own
legally-obtained copies of these three files and place them in `bios/`:
- `scph1001.bin`
- `scph5501.bin`
- `scph7001.bin`

The `pcsx2_libretro` (LRPS2) core does **not** look directly in `bios/` like
the other cores — it requires this exact subfolder layout under the shared
`system_directory`:
- `bios/pcsx2/bios/` — your legally-obtained PS2 BIOS dump (e.g. the
  `SCPH-70004` set: `.BIN`, `.EROM`, `.ROM1`, `.ROM2`)
- `bios/pcsx2/resources/GameIndex.yaml` — the PCSX2 game compatibility
  database. This is marked mandatory by the core (not just recommended) —
  some games won't boot without it. Get it via RetroArch's Online Updater
  ("Update PCSX2 GameIndex", if available) or from the official PCSX2
  project, and place it at that exact path.

The `flycast` core needs a Dreamcast BIOS in `bios/dc/`: place your
legally-obtained `dc_boot.bin` and `dc_flash.bin` there. Flycast creates its
own memory-card saves (`vmu_save_*.bin`), `dc_nvmem.bin` and shader cache in
the same folder on first run.

`bios/Mupen64plus/mupen64plus.ini` (the public N64 ROM catalog used by the
`mupen64plus_next` core) ships as-is — it contains no console firmware, so
there's nothing to source for N64. Its shader cache is built automatically
the first time you play.

See `INSTALL_GUIDE.pdf` for full setup instructions.

## Activity report files (state/)

The server writes two small files in `state/` (gitignored) for Amarin's
activity report in Hotel Liria (`hotel-liria/docs/PLAN-ACTIVITY-NOW-PLAYING.md`
section 4.1). Code: `frontend/now-playing.js`, tests: `cd frontend && npm test`.

- `state/now-playing.json`: the RetroArch game started from the arcade, while
  it runs (`v 1, kind game, state playing, title, pid, since, at`). `title` is
  exactly the card's title from `titles.json` (so the rules above, and ROMs are
  never renamed). Rewritten every 30 s, deleted when the game exits, on the
  Exit button and when the server stops; a leftover from a crash is deleted
  when the server starts. HTML5 games and games loaded from RetroArch's own
  menu are not covered.
- `state/catalog.json`: every game the menu offers, grouped by the menu's
  categories (`CATEGORY_ORDER` in `frontend/app.js`) in the menu's order:
  `{ v, app: "arcade", at, groups: [{ name, items: [titles] }] }`. Written when
  the server starts and again whenever `/api/games` finds a changed list.
- Titles only: no file names, paths or URLs. A failed write is logged once and
  never stops a game launching. No new HTTP route.

## Game names (frontend/titles.json)

ROM files are never renamed: cue/gdi track lists, saves, save states and
per-game settings all depend on the exact file names. The name shown on each
card comes from `frontend/titles.json`, keyed `<system>/<file name>`, with a
small grey info line (region, revision, translation, mod) and an optional
`sort` key. It is read on every page load, so edits show after a refresh.

- "The", "A" and owner names go after the main name: `Lion King, The, Disney's`.
- A real subtitle follows a colon: `Grand Theft Auto: Vice City`.
- ` - Mod` marks a mod, listed right after the original game.
- Discs are `(Disc 1)`, `(Disc 2)`.
- Each system is alphabetical, with a series in release order (II/III sort as
  2/3; `sort` fixes the rest, e.g. Sonic & Knuckles after Sonic 3).

A new game not listed yet still shows a cleaned-up file name (tags in
brackets removed). Patch files (.ips/.bps/.ups) are not listed as games.

### "Fix the title for X in Lirias-Arcade"

1. Find the game's file in `roms/<system>/` (match on any part of the name).
2. Add or edit its entry in `frontend/titles.json` (`"<system>/<exact file name>"`)
   using the rules above. Check the name as the game is known on its box and
   in ads; put region / revision / translation / mod in `info`; add `sort`
   only if the alphabet would put a series out of release order.
3. Never rename, move or edit the ROM, cue, bin or track files.
4. Check it: `curl -s http://localhost:8080/api/games` shows the new title and
   order (no restart needed), then commit and push.
