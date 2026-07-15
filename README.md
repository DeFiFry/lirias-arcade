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

## RetroArch setup (required for ROM games)

Edit `frontend/config.json`:
- `retroarchPath` — path to your `retroarch` executable (or just `"retroarch"` if it's on PATH)
- `coresDir` — folder containing your libretro core files (`.dll` on Windows)
- `systems.<name>.core` — libretro core short name to use per system (defaults are reasonable guesses; change if you use a different core, e.g. `mame_libretro` instead of `mame2003_plus_libretro`)

A starter `retroarch.cfg` is at the project root: keyboard fallback on port 1,
gamepad autodetect on ports 1-4 (up to 4 controllers, auto-assigned in
connection order). Copy/merge it into your RetroArch config directory.

## PSX/PS2 BIOS files (required for PlayStation and PS2 games)

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

`bios/Mupen64plus/` (an N64 ROM catalog + shader cache used by the
`mupen64plus_next` core) ships as-is — it contains no console firmware, so
there's nothing to source for N64.

See `INSTALL_GUIDE.pdf` for full setup instructions.
