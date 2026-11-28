# Liria's Arcade in the living room

Play the arcade on the living-room Mac. The games keep running on this PC (RetroArch and
PCSX2, exactly as now). Sunshine on the PC sends the picture and sound to Moonlight on the
Mac, and Moonlight sends the controller back to the PC. The office monitor shows the game
too, because it is the PC's own screen being streamed.

Nothing here changes how the arcade works on the PC. The streaming programs are separate,
and the arcade's Living Room page is off until you set an Arcade PIN.

## How it fits together

- **PC:** Liria's Arcade (as always) + **Sunshine** (the streaming host, free, from LizardByte).
- **Mac:** **Moonlight** (the streaming player, free, moonlight-stream.org).
- **Controller:** paired with the **Mac** by Bluetooth. Moonlight passes it to the PC, where
  it appears as an Xbox 360 controller through the **ViGEmBus** gamepad driver that Sunshine
  installs. RetroArch, PCSX2 and the arcade menu all see it like a normal pad.
- **Living Room page** (optional): http://lirias-arcade.local:6969 on the Mac, next to Liria
  Cinema (liria-cinema.local:8095) and Playlist Liria (playlist-liria.local:8096). It shows
  whether the arcade and Sunshine are running and these steps. It is read only: games are
  started from Moonlight, never from the page.

## On the PC (once)

1. Run **`streaming\Install Game Streaming.bat`**. It runs
   `winget install --id LizardByte.Sunshine -e`. Windows asks for permission: press **Yes**.
   If the installer offers a **Virtual Gamepad (ViGEmBus)** option, keep it ticked: that is
   the controller driver.
2. Open **https://localhost:47990** in Chrome. Chrome says the connection is not private
   (Sunshine makes its own certificate): click **Advanced**, then **Proceed to localhost**.
3. Create the **Sunshine username and password** yourself. Keep them somewhere safe; nobody
   else sets them.
4. Run **`streaming\Add Arcade To Sunshine.bat`**. Windows asks for permission: press **Yes**.
   It adds **Liria's Arcade** to Sunshine's app list
   (`C:\Program Files\Sunshine\config\apps.json`), saving a backup of the list first
   (`apps.json.bak-<date>-<time>`), then restarts Sunshine so it sees the new app. Running it
   again changes nothing. The app runs the same launch as double-clicking
   `Launch-Arcade.bat`.
   - By hand instead: in the Sunshine page, **Applications**, **Add New**, name
     `Liria's Arcade`, under **Detached Commands** add
     `cmd /c "E:\Projects\Lirias-Arcade\Launch-Arcade.bat"`, working directory
     `E:\Projects\Lirias-Arcade`, Save.
5. In the Sunshine page, **Troubleshooting** (or the front page) should not warn about a
   missing gamepad driver. If it does, install ViGEmBus from
   https://github.com/nefarius/ViGEmBus/releases and restart the PC.
6. Optional, for the Living Room page: run **`Set Arcade PIN.bat`** in the arcade folder,
   choose 1 and type a 4 to 8 digit PIN twice. It then runs
   **`Allow Arcade On Home Network.bat`** (Windows asks: press **Yes**) to let the Mac reach
   port 6969 on the home network only. Then press EXIT in the arcade and open it again.

## On the Mac (once)

1. Install **Moonlight** from **https://moonlight-stream.org** (the macOS download), and open it.
2. The PC should appear by itself. If it does not, press **+** (Add Host) and type
   **192.168.1.11**.
3. Click the PC. Moonlight shows a **4-digit code**.
4. On the PC, in the Sunshine page (https://localhost:47990), go to **PIN**, type that code,
   give the device a name (for example "Living room Mac") and press **Send**. The Mac is now
   paired and is remembered.
5. Pair the **controller** with the Mac: System Settings, **Bluetooth**, put the controller in
   pairing mode (PS5 pad: hold **Create + PS** until the light flashes), click **Connect**.
6. Suggested Moonlight settings (the gear icon): **1080p**, **60 FPS**, bitrate about
   **30 Mbps**, and keep the Mac on **Ethernet** (it is, through the office switch).
7. Optional: bookmark **http://lirias-arcade.local:6969** in Safari or Chrome and type the
   Arcade PIN once.

## Playing

1. Turn the controller on (it reconnects to the Mac by itself).
2. Open Moonlight, click the PC, click **Liria's Arcade**. The arcade opens on the PC and
   its picture comes to the Mac.
3. Choose and play a game with the controller, as at the desk.
4. To stop: quit the game as usual, then leave the stream with **Control+Option+Shift+Q**
   on the Mac keyboard, or hold **Start+Select+L1+R1** on the controller. The arcade keeps
   running on the PC; its EXIT button closes it, as always.

Sound plays on the Mac. The office monitor shows the same picture while you stream.

## If something does not work

- **Nothing loads, the Mac shows the network as green:** on the Mac, System Settings,
  Network, USB LAN (Ethernet), Details, TCP/IP, **Renew DHCP Lease**, then wait a full
  **60 seconds** and try again.
- **Moonlight does not find the PC:** add it by **192.168.1.11** (Add Host). Sunshine must be
  running on the PC (its icon in the tray; the Living Room page says so too).
- **The controller does nothing in the game:** check it is connected to the Mac (Bluetooth),
  and that Sunshine shows no gamepad driver warning (ViGEmBus, step 5 on the PC). If a pad
  is also plugged into the PC, the Mac's pad may be player 2: unplug or turn off the PC's pad.
- **The picture stutters:** lower the bitrate to 20 Mbps, or the resolution to 720p.
- **lirias-arcade.local does not open:** use http://192.168.1.11:6969 instead, and check that
  an Arcade PIN is set and the arcade was restarted after setting it.

## What is where

- `streaming\Install Game Streaming.bat`: installs Sunshine with winget.
- `streaming\Add Arcade To Sunshine.bat` and `streaming\sunshine-app.js`: adds the app to
  Sunshine's list (backup first, safe twice).
- `Set Arcade PIN.bat`, `Allow Arcade On Home Network.bat`: the Living Room page's PIN and
  firewall rules ("Liria's Arcade (home network, TCP 6969)" and
  "Liria's Arcade (home network, mDNS)", Private networks only, separate from the cinema's
  and the playlist's rules).
- `frontend\lib\living-room.js`, `lan.js`, `lan-page.js`, `mdns.js`, `sunshine.js`: the
  Living Room page (see the README section "Living room (home network)").
