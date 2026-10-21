# Radionette

An internet radio built with a Raspberry Pi. Turn a physical dial to switch between radio stations. Flip to Bluetooth mode and it becomes a wireless speaker.

## What It Does

- **Radio mode:** A rotary switch selects a band (e.g. Norsk, BBC) and a magnetic angle sensor on the tuning needle picks a station within the band. 30+ internet radio streams (HTTP MP3/icecast and HLS). Audio plays through the Pi's 3.5mm jack or HDMI.
- **Bluetooth mode:** The Pi becomes a discoverable Bluetooth speaker called "Radionette" (with a speaker icon on your phone). Pair and stream music from any device.
- **Round-panel display:** A GC9A01 1.28" round IPS display shows the current channel logo, or dynamically-fetched album art matching the current song from iTunes Search. Channels without a proper logo file get a synthesised text-tile logo.
- **Physical display settings:** The selector's lower four bits choose album-art/logo-only content and auto-off/always-on behavior, with a fully-off position. Encodings are configurable per radio.
- **Web status page:** An artwork-forward live dashboard at `http://radionette.local:8080/` shows album art or station logos, now-playing metadata, playback/volume/display state, Bluetooth status, and the configured station catalogue.
- **WiFi configuration:** If the Pi can't connect to a known WiFi network at boot, it creates an open hotspot (`Radionette-Setup`, no password). Connect to the hotspot and visit `http://10.42.0.1:8080/wifi` to configure a network. WiFi settings are also always accessible at `http://radionette.local:8080/wifi` when connected to the same network.
- **Debug page:** A live view of GPIO bit state, current band, tuner needle position with per-band wedge markers, full state dump, and grouped channel map at `http://radionette.local:8080/debug`. Includes a virtual dial for switching bands from the browser, tuner calibration buttons, WiFi reset and system reboot controls.
- **Settings page:** Per-radio station, band, hardware-mapping and display-tint editor at `http://radionette.local:8080/settings`, with validated import/export backups. Settings live under `~/.radionette/` and survive deployments.
- **Hotspot bleep alert:** When the Pi is in radio mode and the hotspot is active (no WiFi configured), a periodic bleep sounds through the speaker to alert the user to set up WiFi.
- **Auto-retry playback:** If the radio stream fails (e.g. no internet during hotspot mode), the player retries with escalating backoff (5s, 10s, 30s). Playback also resumes automatically when WiFi is configured via the settings page.

## Hardware

- Raspberry Pi 4 Model B
- Rotary dial switch wired to 10 GPIO input pins
- Mono/stereo switch on 1 GPIO input pin
- Active-HIGH relay on GPIO 17 controlling the 12 V amplifier and radio lights
- Bluetooth indicator LED
- GC9A01 1.28" 240x240 round IPS display on SPI0
- ADS1115 16-bit ADC on I2C bus 1 for the volume potentiometer (AIN0)
- AS5600 12-bit magnetic angle sensor on I2C bus 1 (address 0x36), reading the tuning-needle shaft angle directly over I2C
- Audio output via 3.5mm jack or HDMI

### GPIO Pin Assignments

All input pins use internal pull-down resistors.

```
                      +---]+---+
                 3V3 =|  1   2 |= 5V
         (SDA)  GP02 =|  3   4 |= 5V
         (SCL)  GP03 =|  5   6 |= GND
                GP04 =|  7   8 |= GP14 (TXD)
                 GND =|  9  10 |= GP15 (RXD)
    [12V RELAY]  GP17 =| 11  12 |= GP18 [CH BIT 0]
                GP27 =| 13  14 |= GND
                GP22 =| 15  16 |= GP23 [CH BIT 1]
                 3V3 =| 17  18 |= GP24 [CH BIT 2]
        (MOSI)  GP10 =| 19  20 |= GND
        (MISO)  GP09 =| 21  22 |= GP25 [CH BIT 3]
        (SCLK)  GP11 =| 23  24 |= GP08 (SPI0 CE0) 
                 GND =| 25  26 |= GP07 [CH BIT 5]
                GP00 =| 27  28 |= GP01
   [CH BIT 4]   GP05 =| 29  30 |= GND                 
                GP06 =| 31  32 |= GP12 [CH BIT 6]
   [BACKLIGHT]  GP13 =| 33  34 |= GND
      [STEREO]  GP19 =| 35  36 |= GP16 [CH BIT 7]
      [BT LED]  GP26 =| 37  38 |= GP20 [BLUETOOTH]
                 GND =| 39  40 |= GP21 [POWER]
                      +--------+
```

| BCM | Phys | Dir | Function |
|-----|------|-----|----------|
| 18 | 12 | In | Channel bit 0 |
| 23 | 16 | In | Channel bit 1 |
| 24 | 18 | In | Channel bit 2 |
| 25 | 22 | In | Channel bit 3 |
| 5 | 29 | In | Channel bit 4 |
| 7 | 26 | In | Channel bit 5 |
| 12 | 32 | In | Channel bit 6 |
| 16 | 36 | In | Channel bit 7 |
| 20 | 38 | In | Bluetooth mode |
| 21 | 40 | In | Power indicator |
| 19 | 35 | In | Audio mode (LOW = mono [default], HIGH = stereo) |
| 17 | 11 | Out | Active-HIGH 12 V relay control |
| 26 | 37 | Out | Bluetooth LED |
| 13 | 33 | Out | Display backlight (LEDA or BLK, on/off) |
| 8  | 24 | Out | Display CS (SPI0 CE0) |
| 11 | 23 | Out | Display SCLK (SPI0) |
| 10 | 19 | Out | Display MOSI (SPI0 DIN) |
| 27 | 13 | Out | Display D/C |
| 22 | 15 | Out | Display RESET |

### 12 V Relay, Amplifier, and Radio Lights

GPIO 17 controls the relay module through its 3.3 V-compatible `IN` terminal. The relay is active HIGH. Its control side is powered from the Pi supply according to the relay module's rated VCC; connect control ground to Pi ground.

The relay contacts switch a separate 12 V circuit:

- 12 V positive → relay `COM`
- relay `NO` → amplifier positive and radio-light positive (in parallel)
- amplifier and radio-light negative → 12 V negative
- Pi audio output (3.5 mm or HDMI audio path) → amplifier audio input

The firmware boot configuration holds GPIO 17 as an output LOW (`gpio=17=op,dl`) so the active-HIGH relay stays off while Linux starts. The app then initializes it directly from the physical power input, avoiding an extra off/on pulse during app startup.

### Display Wiring

The radio supports either the existing bare GC9A01 panel or an 8-pin GC9A01 PCB module. Both use SPI0 and 3.3 V logic. The backlight is driven directly by GPIO 13 (active HIGH) and turns off automatically 20 seconds after the last user-visible event.

Complete drawings are available in [`docs/radionette-wiring.pdf`](docs/radionette-wiring.pdf). The editable source is [`docs/radionette-wiring.vectorcraft`](docs/radionette-wiring.vectorcraft).

#### Existing bare panel (14/15-pin variant)

| Display pin | Display label | -> Pi BCM | -> Pi header pin |
|---|---|---|------------------|
| 1 | GND | GND | 39               |
| 2 | LEDK | GND | 39               |
| 3 | LEDA | GPIO 13 | 33               |
| 4 | VDD | 3V3 | 1                |
| 5 | D/C | GPIO 27 | 13               |
| 6 | CS | GPIO 8 (CE0) | 24               |
| 7 | SCL | GPIO 11 (SCLK) | 23               |
| 8 | SDA | GPIO 10 (MOSI) | 19               |
| 9 | RESET | GPIO 22 | 15               |
| 10-15 | TP-* | (touch — leave open) | —                |

This table documents the radio as built: LEDA connects directly to GPIO 13 and LEDK connects to ground; there is no MOSFET. Verify the panel backlight current is within GPIO limits before duplicating this arrangement with a different bare panel.

#### Optional 8-pin PCB module

| Module label | -> Pi BCM | -> Pi header pin |
|---|---|---|
| GND | GND | 39 |
| VCC | 3V3 | 1 |
| SCL | GPIO 11 (SCLK) | 23 |
| SDA | GPIO 10 (MOSI) | 19 |
| RES | GPIO 22 | 15 |
| DC | GPIO 27 | 13 |
| CS | GPIO 8 (CE0) | 24 |
| BLK | GPIO 13 | 33 |

The 8-pin module must be a 2.8–3.3 V GC9A01 module. Its BLK input is assumed active HIGH, matching the existing backlight software. Do not connect a 5 V-only module directly to the Pi.

### Analog Tuner Wiring (AS5600 + ADS1115)

The volume potentiometer is read via an ADS1115 ADC on I2C bus 1; the AS5600 magnetic angle sensor sits on the same bus at a different address. Both chips share SDA/SCL, VDD and GND. The tuner reads angle over I2C directly (not through the ADS1115), so ADS1115 AIN1 is left free for future use.

| Signal | Wire from | Wire to | Notes |
|---|---|---|---|
| ADS1115 VDD | Pi 3V3 (pin 1 or 17) | ADS1115 VDD | Shared 3V3 with AS5600 |
| ADS1115 GND | Pi GND | ADS1115 GND | |
| ADS1115 SDA | Pi GPIO 2 (pin 3) | ADS1115 SDA | Shared I2C bus |
| ADS1115 SCL | Pi GPIO 3 (pin 5) | ADS1115 SCL | Shared I2C bus |
| ADS1115 ADDR | GND | ADS1115 ADDR | → address 0x48 |
| ADS1115 AIN0 | volume pot wiper | ADS1115 AIN0 | See "Volume" |
| ADS1115 AIN1 | *unused* | — | Reserved for future analog input |
| AS5600 VDD | Pi 3V3 | AS5600 VDD | |
| AS5600 GND | Pi GND | AS5600 GND | |
| AS5600 SDA | Pi GPIO 2 (pin 3) | AS5600 SDA | Shared I2C bus with ADS1115 |
| AS5600 SCL | Pi GPIO 3 (pin 5) | AS5600 SCL | Shared I2C bus with ADS1115 |
| AS5600 DIR | GND | AS5600 DIR | Fix direction; can be inverted in software instead |
| AS5600 OUT | *not connected* | — | Analog OUT is unused; we read angle over I2C |
| AS5600 PGO | *not connected* | — | |

The AS5600's DIR pin must be tied to a defined level. Tying it to GND selects one rotation direction; if the needle ends up moving the wrong way through the channel list, either flip DIR to 3V3 or use the "Invert" toggle in the `/debug` Tuner panel.

**Magnet:** a diametrically-magnetized disc (typically 6 mm × 3 mm) glued to the needle shaft, 0.5-3 mm above the AS5600 IC surface. The `/debug` Tuner panel captures the two mechanical endpoints (as 12-bit angle counts, 0..4095) and stores them in `~/.radionette/tuner-calibration.json`. The tuner correctly handles calibrations that straddle the 0/4095 wrap point.

**How tuning works:** the top nibble (bits 7-4) of the existing 8-bit rotary selector switch chooses the band via the `bands` table in `channels.json`; the AS5600 needle angle then picks a station within that band by dividing the calibrated sweep into equal wedges (one per station currently in the band). When the AS5600 is missing or uncalibrated the code falls back to playing the first channel (by `order`) in the current band, so the radio always has something to play as long as the band has at least one station. Physical rotary positions whose hardware nibble doesn't match any declared band are silent.

**Magnet health:** the tuner polls the AS5600 STATUS register once per second and logs transitions (`OK` ↔ `TOO WEAK` / `TOO STRONG` / `NOT DETECTED`) along with the AGC value. If the magnet falls out of alignment or drops off entirely, you'll see a `[Tuner] AS5600 magnet OK → NOT DETECTED` log line and the fraction reading will freeze at the last-known value.

### Logo Assets

Channel and mode logos are PNG or animated GIF files in `assets/channel-logos/`. They're rendered at native size into a 240x240 round-masked frame ("contain" fit, centred, black corners).

- Reference channel logos from `channels.json` via the `logo` field, e.g. `"logo": "NRK-P1.png"`.
- Special filenames consumed by the display service:
  - `default.png` — shown during the power-on splash.
  - `bluetooth.png` — shown in BT mode while no device is connected.
  - `bluetooth-connected.png` — shown in BT mode while a device is connected.
- Channels with no `logo` field, or a `logo` pointing at a missing file, get a **synthesised text-tile logo** at runtime — black background with the station name centred in white. See "Configuring Stations" below.
- Animated GIFs play indefinitely; per-frame delays from the GIF are honoured (clamped to >=20 ms).
- Logos are cached in memory after first decode; restart radionette to pick up file changes.
- On every power-on, `default.png` is shown for 2 s before the channel/BT logo appears (a brief "splash" so the panel doesn't snap straight to content).

### Now-playing album art

Radio streams don't carry image URLs in their metadata — ICY tags and HLS manifests only expose text. What they do carry is a "Now playing" string that usually formats as `Artist - Song`. When a new title arrives on `player:metadata`, `src/artwork.ts` parses the string, queries the free iTunes Search API for that song, and — on a hit — pushes the album-art URL through `radioState.setArtwork()`. The display service prefers this URL over the channel's static logo whenever it's fresh, and falls back to `channel.logo` on:

- No metadata yet (just tuned in)
- Metadata that isn't `Artist - Song` (news, programme names, station idents)
- iTunes miss (song not in the catalogue)
- Channel change or player stop (artwork is cleared)

The URL is downloaded and decoded through the same logo pipeline (240x240, round-masked). Results are cached in memory keyed by `Artist - Title` so repeated songs don't re-hit the API. Everything is opportunistic — a network hiccup or an API 500 just leaves the channel logo in place.

## Raspberry Pi Setup

### 1. OS & Network

1. Flash **Raspberry Pi OS** (desktop or headless — PulseAudio auto-starts via socket activation)
2. Set hostname to `radionette`
3. Enable SSH
4. Ensure the Pi is reachable as `ssh pi@radionette.local` from your dev machine (via mDNS)

### 2. Clone & Install

From your dev machine (requires Node.js and npm locally):

```bash
git clone <this-repo>
cd radionette
npm install
```

### 3. Automated Pi Setup

The `setup-pi.sh` script handles everything: nvm, Node.js LTS, system packages, Bluetooth configuration, pm2 installation, and boot persistence. Run it from your dev machine:

```bash
npm run setup-pi
```

This installs nvm and Node.js LTS, then installs `mpg123`, `ffmpeg`, `bluez`, `rfkill`, `pulseaudio` (+ Bluetooth module), `i2c-tools`, `build-essential`, and `python3`. It enables SPI and I2C in `/boot/firmware/config.txt`, configures the Bluetooth device class for the speaker icon, installs pm2, sets up auto-start on boot, and installs the wifi-fallback systemd service.

### 4. First Deploy

```bash
npm run deploy
```

This builds the TypeScript, syncs everything to the Pi, starts the app via pm2, and saves the process list. The deploy script auto-detects the remote Node.js path. If `node_modules` is missing on the Pi it will run `npm install` automatically. Two variants force it explicitly:

- `npm run deploy:install` — force `npm install` on the Pi over the existing tree
- `npm run deploy:refresh` — wipe `node_modules` on the Pi and reinstall from scratch

With both radios on the network, select the destination explicitly:

- `npm run deploy:minuett` — deploy to `pi@minuett.local`
- `npm run deploy:radionette` — deploy to `pi@radionette.local`

Both target commands accept the dependency flags, for example `npm run deploy:radionette -- --install` or `npm run deploy:minuett -- --refresh`. Plain `npm run deploy` targets Radionette. For initial setup, use `npm run setup-pi:minuett` or `npm run setup-pi:radionette`; plain `npm run setup-pi` also targets Radionette.

### 5. Verify

- Open `http://radionette.local:8080/` in a browser — you should see the status page
- Turn the dial — the station should change and audio should play
- Switch to Bluetooth mode — "Radionette" should appear as a speaker on your phone

## WiFi Configuration

The Radionette includes a built-in WiFi configuration system so you can set up the Pi's network connection without a keyboard or monitor.

### How It Works

1. **On boot**, the `wifi-fallback` systemd service waits 30 seconds for the Pi to connect to a known WiFi network.
2. **If no connection is established**, the Pi starts an open WiFi hotspot:
   - **SSID:** `Radionette-Setup`
   - **No password** (open network)
3. **Connect** your phone or laptop to the hotspot, then open `http://10.42.0.1:8080/wifi` in a browser.
4. **Select a network** from the scan list, enter the password, and tap Connect.
5. **The Pi connects** to the new network and the hotspot shuts down automatically. Reconnect your device to the same network and visit `http://radionette.local:8080/` to verify.

### WiFi Settings Page

The WiFi settings page is always available at `http://radionette.local:8080/wifi`, not just in hotspot mode. Use it to:
- View the current WiFi connection status
- Scan for available networks
- Connect to a different network

### API Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/wifi` | WiFi settings page |
| GET | `/debug` | Debug page (GPIO bits, state, channel map) |
| GET | `/settings` | Persistent per-radio settings editor |
| GET | `/api/wifi/status` | Current WiFi status (JSON) |
| GET | `/api/wifi/scan` | Scan for available networks (JSON) |
| POST | `/api/wifi/connect` | Connect to a network (`{ "ssid": "...", "password": "..." }`) |
| POST | `/api/debug/gpio` | Inject a virtual GPIO value (`{ "value": 0-1023 }`) |
| POST | `/api/debug/gpio/reset` | Reset virtual dial override, revert to physical GPIO |
| POST | `/api/debug/reset` | Clear all temporary debug overrides and restore physical controls/default tint |
| POST | `/api/debug/channel` | Temporarily select a channel until the physical tuner moves |
| POST | `/api/system/wifi-reset` | Delete all saved WiFi networks and reboot |
| POST | `/api/system/reboot` | Reboot the Pi |
| GET | `/api/settings` | Read editable local settings |
| POST | `/api/settings/login` | Exchange the settings PIN for an 8-hour session cookie |
| POST | `/api/settings/logout` | End the current settings session |
| PUT | `/api/settings/pin` | Change the settings PIN and invalidate all sessions |
| PUT | `/api/settings/channels` | Save bands and stations |
| PUT | `/api/settings/band-mapping` | Save per-radio band nibbles |
| PUT | `/api/settings/display-mapping` | Save per-radio display nibbles |
| PUT | `/api/settings/tint` | Save and apply the default tint |
| GET | `/api/settings/export` | Download a complete settings backup |
| POST | `/api/settings/import` | Validate and import a settings backup |

The settings page and `/api/settings/*` APIs use a PIN with an 8-hour session cookie. The initial PIN is `1972`; change it under **Settings → Security**. The saved PIN is stored as a salted scrypt hash and is not included in settings exports. Debug write APIs remain unauthenticated, so only expose port 8080 on trusted networks.

## Development

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript
npm run dev          # Watch mode (auto-rebuild on changes)
npm run deploy       # Build + deploy to Pi + restart
```

When running on a machine without GPIO (e.g. your laptop), the app falls back to dev mode — power defaults to on and the web UI works normally.

### Local Settings

Some files contain settings specific to this setup that you'll want to adapt:

- **`deploy.sh`** — Targets Radionette by default. Set `RADIONETTE_REMOTE` to another SSH destination, or use the `deploy:minuett` / `deploy:radionette` npm commands. The Node.js path is detected automatically.
- **`channels.json`** — Pre-configured with Norwegian radio stations (NRK, P4, etc.). Replace with your own station URLs.
- **`src/bluetooth.ts`** — PulseAudio commands (`paplay`, `pactl`) run natively as the `pi` user. The `rfkill` command runs via `sudo`. No manual changes needed.

### Per-radio band mapping

Different physical selector switches can produce different top-nibble values. To override only the hardware mapping on one Pi without changing the shared `channels.json`, create `~/.radionette/band-mapping.json` on that Pi:

```json
{
  "1": 0,
  "2": 3,
  "3": 1,
  "4": 4
}
```

Keys are logical band ordinals and values are the physical top-nibble readings (`0..15`). The override persists across deployments. Set `RADIONETTE_BAND_MAPPING` to use a different file path.

### Per-radio display settings

The selector's lower nibble (bits 3–0) controls display content and backlight timing. Because switch encodings differ between radios, the mapping is local to each Pi. Create `~/.radionette/display-mapping.json`:

```json
{
  "autoArtwork": 0,
  "autoLogo": 2,
  "alwaysArtwork": 1,
  "alwaysLogo": 4,
  "off": 8
}
```

All five values must be unique integers from `0` through `15`. The modes are:

- `autoArtwork` — channel logo and album art; backlight turns off after 20 seconds
- `autoLogo` — channel logo only; backlight turns off after 20 seconds
- `alwaysArtwork` — channel logo and album art; backlight stays on
- `alwaysLogo` — channel logo only; backlight stays on
- `off` — black frame and backlight off

The selected timing also applies in Bluetooth mode. A debug-page logo override may temporarily turn on a physically disabled display; clearing the override restores the physical setting. If the mapping file is absent or invalid, every lower-nibble value safely falls back to normal `autoArtwork` behavior. Set `RADIONETTE_DISPLAY_MAPPING` to use another path.

The default display tint is **Ember** (`R=1.15`, `G=0.60`, `B=0.30`). It can still be adjusted live from the debug page.

## Configuring Stations

Edit `channels.json`. The file has two top-level arrays: `bands` and `channels`.

```json
{
  "bands": [
    { "ordinal": 1, "hardware": 12, "name": "Band 1" },
    { "ordinal": 2, "hardware": 8,  "name": "Band 2" },
    { "ordinal": 3, "hardware": 10, "name": "Band 3" },
    { "ordinal": 4, "hardware": 3,  "name": "Band 4" }
  ],
  "channels": [
    { "id": "nrk-p1",     "band": 1, "order": 10,  "name": "NRK P1",       "url": "https://lyd.nrk.no/...", "logo": "NRK-P1.png" },
    { "id": "bbc-r1",     "band": 1, "order": 200, "name": "BBC Radio 1",  "url": "https://as-hls-ww-live.akamaized.net/...", "logo": "BBC-Radio-1.png" },
    { "id": "radio-rock", "band": 2, "order": 10,  "name": "Radio Rock",   "url": "https://live-bauerno.sharp-stream.com/...", "logo": "RadioRock.png" }
  ]
}
```

- **Bands** are the physical rotary switch positions. `ordinal` is the logical band number used in code and UI. `hardware` is the raw top-nibble (0..15) the physical rotary produces for this band. `name` is a human label.
- **Channels** each reference a `band` ordinal and carry an `order` value that decides where the station falls on the tuner's needle sweep — the AS5600 divides the sweep into equal wedges (one per channel in the current band) and stations are laid out in increasing `order` from the CCW end to the CW end. Sparse values (10, 20, 30, ...) let you insert new stations between existing ones without renumbering.
- **`id`** is a stable string identifier used in logs and in the state broadcast.
- **`logo`** is a filename (PNG or GIF) under `assets/channel-logos/`. If omitted (or the file is missing), the display service generates a text-only fallback logo with a black background and centred white station name.

There is **no cap** on channels per band — 4 channels or 40, the needle fills the full sweep either way. Bands with no channels are silent. Physical rotary positions whose hardware nibble doesn't match any declared band are also silent.

**Supported stream types:**

- **Direct MP3 / icecast** (`https://.../stream.mp3`, icecast `/;` mount points) — played by `mpg123`. Fastest to start, native ICY metadata.
- **HLS** (`https://.../playlist.m3u8`) — played by `ffmpeg` into PulseAudio directly. Supports AAC / HE-AAC / MP3 segments. The player picks the backend automatically based on the URL.

## Project Structure

```
radionette/
  src/
    index.ts             # Entry point — wires all modules
    state.ts             # Central state machine + event emitter
    gpio.ts              # GPIO polling, debounce, LED control
    channels.ts          # channels.json loader; bands + channels indexes
    player.ts            # mpg123 (MP3) / ffmpeg (HLS) child process management
    bluetooth.ts         # Bluetooth A2DP sink management
    audio.ts             # Mono/stereo mixing (PulseAudio remap-sink)
    adc.ts               # Shared ADS1115 access on /dev/i2c-1
    volume.ts            # Volume pot reader (ADS1115 AIN0)
    tuner.ts             # AS5600 magnetic angle tuner over I2C
    artwork.ts           # Now-playing metadata -> iTunes album-art lookup
    backlight.ts         # Display backlight controller (GPIO 13)
    display.ts           # Low-level GC9A01 SPI driver
    display-service.ts   # State -> logo mapping (channel/artwork/text-tile)
    display-settings.ts  # Per-radio lower-nibble display policy mapping
    display-preferences.ts # Persistent default tint
    config-storage.ts    # Atomic local JSON writes + backups
    settings-security.ts # Settings PIN hashing and session management
    render/
      displayController.ts # Paint queue, animation timer
      logos.ts             # Logo loader: files, http URLs, text: tiles
      frame.ts             # RGBA8888 -> RGB565 + display tint
    wifi.ts              # WiFi scanning, connecting, hotspot (nmcli)
    hotspot-alert.ts     # Periodic bleep when hotspot is active in radio mode
    web.ts               # HTTP + WebSocket server
    public/
      index.html         # Artwork-first live status dashboard
      wifi.html          # WiFi scan/connect page
      debug.html         # GPIO, tuner, channel override and diagnostics
      settings.html      # Stations, mappings, tint, backup/import editor
      settings-login.html # PIN login for persistent settings
      app.css            # Shared visual shell for all web pages
    gpio-logger.ts       # Utility for mapping dial positions
    scripts/
      display-smoke.ts       # Colour-bar hardware test for the GC9A01
      display-render-test.ts # Cycle every channel logo through the pipeline
      as5600-monitor.ts      # Live AS5600 angle/health monitor
  assets/
    channel-logos/       # Per-station logo PNG/GIF files (+ default/bluetooth)
    bt-connect.wav       # Sound: device connected
    bt-ready.wav         # Sound: BT mode active / device disconnected
    hotspot-bleep.wav    # Sound: 880Hz tone + silence, loops while hotspot active
  channels.json          # Band + station configuration
  deploy.sh              # Build + deploy script
  setup-pi.sh            # One-time Pi setup script
  wifi-fallback.sh       # Boot script: start hotspot if no WiFi
  package.json
  tsconfig.json
```

## License

Private project.
