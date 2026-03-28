# Radionette

Internet radio controller for Raspberry Pi 3 Model B. Reads physical radio dial position via GPIO, plays internet radio streams, serves a live web status page, and acts as a Bluetooth A2DP audio sink.

## Architecture

### Hardware
- **Raspberry Pi 3 Model B**
- **10 GPIO input pins** from a physical rotary dial switch
  - Bits 0-7 (GPIO 18, 23, 24, 25, 8, 7, 12, 16): Channel selector — 15 unique positions across two banks
  - Bit 8 (GPIO 20): Bluetooth indicator
  - Bit 9 (GPIO 21): Power indicator
- **2 GPIO output pins** for indicator LEDs
  - GPIO 11: Power LED
  - GPIO 26: Bluetooth LED
- Audio output via 3.5mm jack or HDMI

### State Machine

```
Power OFF (bit 9 LOW)
  -> Everything stops. LEDs off. Web shows "Power Off".

Power ON + Bluetooth ON (bit 8 HIGH)
  -> Radio stops. Power LED on, BT LED on.
  -> BT adapter enabled, discoverable as "Radionette" (speaker icon).
  -> Plays bt-ready.wav sound.
  -> Phones can connect and stream audio via A2DP.
  -> Plays bt-connect.wav when a device connects.
  -> Plays bt-ready.wav when a device disconnects.

Power ON + Bluetooth OFF
  -> Radio mode. Read bits 0-7, look up channel, play stream.
  -> Power LED on, BT LED off. Web shows station + metadata.
```

### Modules

| File | Purpose |
|---|---|
| `src/index.ts` | Entry point — wires modules: channels -> player -> bluetooth -> web -> gpio |
| `src/state.ts` | Central state singleton + EventEmitter. All modules communicate through this. |
| `src/gpio.ts` | Reads 10 input pins every 10ms, debounces (50ms), drives state machine, controls LED outputs. Falls back to dev mode when rpio unavailable. |
| `src/channels.ts` | Loads `channels.json` at startup. Looks up channel number -> name + URL. |
| `src/player.ts` | Spawns/kills `/usr/bin/mpg123` child processes. Parses ICY stream metadata. Reacts to state events. |
| `src/bluetooth.ts` | Full Bluetooth A2DP sink management — enable/disable adapter, pairing agent, device monitoring, volume boost, flap detection, auto-reconnect, notification sounds. |
| `src/web.ts` | HTTP server (port 80) + WebSocket. Serves status page, WiFi settings page, and WiFi API endpoints. Pushes live state to all connected clients. |
| `src/wifi.ts` | WiFi management via `nmcli` — scan for networks, connect, start/stop hotspot. Falls back to mock data in dev mode. |
| `src/public/index.html` | Single-file status page with inline CSS/JS. Dark theme, live WebSocket updates. Shows BT device name when connected. Link to WiFi settings. |
| `src/public/wifi.html` | Single-file WiFi settings page with inline CSS/JS. Dark theme, network scan list with signal bars, connect modal with password field, AP-mode warning. |
| `src/gpio-logger.ts` | Standalone utility — logs raw GPIO values on change for mapping physical dial positions. |
| `channels.json` | Channel configuration — maps dial position numbers to station name + stream URL. Edit this to change stations. |
| `wifi-fallback.sh` | Boot script — waits 30s for WiFi, starts hotspot if no connection. Installed as a systemd service by `setup-pi.sh`. |
| `assets/bt-connect.wav` | Ascending two-tone chime played when a Bluetooth device connects. |
| `assets/bt-ready.wav` | Soft single tone played when BT mode activates or a device disconnects. |

### Event Flow

```
GPIO poll (10ms) -> debounce (50ms) -> state.ts EventEmitter
  |- player.ts listens   -> spawns/kills mpg123
  |- bluetooth.ts listens -> enables/disables BT adapter
  +- web.ts listens       -> broadcasts to WebSocket clients
```

Events emitted by state.ts:
- `power:on` / `power:off`
- `mode:bluetooth` / `mode:radio`
- `channel:change` (with channel info)
- `player:playing` / `player:stopped`
- `player:metadata` (ICY stream info)
- `state:change` (full state snapshot, used by web)

### Channel Config

`channels.json` maps GPIO bits 0-7 decimal values to streams. The dial has two banks sharing 5 center positions:

- **Shared (center):** 224, 225, 232, 234, 236
- **Bank A:** 140, 138, 136, 129, 128
- **Bank B:** 124, 122, 120, 113, 112

Add any HTTP/MP3 stream URL. No rebuild needed — just edit the file and restart.

### Bluetooth Details

The Bluetooth module (`src/bluetooth.ts`) manages:

- **Adapter control:** `rfkill unblock` + `bluetoothctl power on/off`
- **Discoverable name:** "Radionette" (set via `bluetoothctl system-alias`)
- **Device class:** `0x240414` (Loudspeaker) — configured in `/etc/bluetooth/main.conf`, shows speaker icon on phones
- **Pairing agent:** `DisplayYesNo` with auto-accept — handles iPhone passkey confirmation prompts
- **Volume boost:** BT audio sink-inputs boosted to 120% via `pactl set-sink-input-volume`
- **Flap detection:** 3 disconnects in 10 seconds -> device removed from BlueZ, 30s cooldown
- **Auto-reconnect:** Reconnects to last stable device (connected >5s) when BT mode re-enabled
- **Notification sounds:** `bt-connect.wav` and `bt-ready.wav` played via `paplay`

All system binaries use absolute paths (`/usr/sbin/rfkill`, `/usr/bin/bluetoothctl`, `/usr/bin/pactl`, `/usr/bin/paplay`) because pm2 runs with a minimal PATH.

PulseAudio runs as the desktop user but the app runs as root. PulseAudio paths are detected at runtime using `SUDO_UID`/`SUDO_USER` environment variables (set automatically by `sudo`), falling back to `os.userInfo()`. No hardcoded user paths.

### WiFi Details

The WiFi module (`src/wifi.ts`) provides:

- **Network scanning:** `nmcli device wifi list` with deduplication and signal sorting
- **Connecting:** `nmcli device wifi connect` — stops hotspot first if active, restarts it if connection fails
- **Hotspot:** `nmcli device wifi hotspot` — SSID `Radionette-Setup`, password `radionette`, connection name `radionette-hotspot`
- **Status:** Reads wlan0 device state via `nmcli device show`
- **Dev mode:** If `nmcli` is unavailable (laptop), returns mock data

Uses absolute path `/usr/bin/nmcli`. The hotspot connection profile (`radionette-hotspot`) is deleted on stop to avoid accumulating stale profiles.

**WiFi fallback boot service:**
- `wifi-fallback.sh` runs at boot via `wifi-fallback.service` (systemd, oneshot)
- Waits up to 30 seconds (checking every 5s) for wlan0 to connect
- If no connection, starts the hotspot via nmcli
- Logs to systemd journal (`logger -t wifi-fallback`)

**API endpoints** (served by `src/web.ts`):

| Method | Path | Description |
|---|---|---|
| GET | `/wifi` | WiFi settings HTML page |
| GET | `/api/wifi/status` | JSON: `{ connected, ssid, ip, hotspotActive }` |
| GET | `/api/wifi/scan` | JSON: `[{ ssid, signal, security, active }]` |
| POST | `/api/wifi/connect` | JSON body: `{ ssid, password }` → `{ success, error? }` |

**Pi 3 compatibility:** The BCM43438 WiFi chip on the Pi 3 Model B supports AP mode. Both Pi 3 and Pi 4 support simultaneous AP + managed on the same channel, but the implementation uses a simpler approach: stop AP → connect → restart AP if connection fails.

## Development

Built with TypeScript on a dev machine, runs as compiled JS on the Pi.

```bash
npm install          # Install dependencies (dev machine)
npm run build        # Compile TypeScript -> dist/
npm run dev          # Watch mode
```

When rpio is unavailable (not on a Pi), GPIO falls back to dev mode — power defaults to on, web UI still works.

## Deployment

```bash
npm run deploy       # Builds, rsyncs to pi@radionette:~/code/, installs deps, restarts pm2
```

The deploy script (`deploy.sh`) does:
1. `npm run build` (TypeScript -> JS)
2. rsync `dist/` to Pi (with `--delete`)
3. rsync `channels.json`, `package.json`, `package-lock.json` to Pi
4. rsync `src/public/` to `dist/public/` on Pi (HTML not handled by tsc)
5. rsync `assets/` to Pi (sound files)
6. rsync `wifi-fallback.sh` to Pi (+ chmod +x)
7. `npm install --omit=dev` on Pi (compiles native `rpio` addon)
8. `pm2 restart radionette`

## Raspberry Pi Setup

### Prerequisites

- Raspberry Pi (3 Model B, 4, or compatible) with Raspberry Pi OS (desktop variant, for PulseAudio)
- Hostname set to `radionette`
- SSH enabled, accessible as `ssh radionette` from dev machine
- Node.js v24.14.1 installed via nvm

### Automated Setup

Run `setup-pi.sh` from the dev machine to install all system packages, configure Bluetooth, install pm2, and set up boot persistence:

```bash
ssh radionette 'bash -s' < setup-pi.sh
```

The script auto-detects the username and Node.js path — works with any user, not just `pi`.

### What setup-pi.sh does

1. **System packages:** `mpg123`, `bluez`, `rfkill`, `pulseaudio` (+ bluetooth module), `build-essential`, `python3`
2. **Bluetooth device class:** Sets `Class = 0x240414` in `/etc/bluetooth/main.conf` (speaker icon)
3. **pm2:** Installs globally, configures systemd startup service
4. **Convenience:** Adds a `pm2` alias to `~/.bashrc` (handles sudo + PATH automatically)
5. **WiFi fallback:** Installs `wifi-fallback.service` systemd unit pointing to `~/code/wifi-fallback.sh`, enables it for boot

| Package | Purpose |
|---|---|
| `mpg123` | Internet radio stream playback |
| `bluez` | Bluetooth stack (`bluetoothctl`) |
| `rfkill` | Block/unblock Bluetooth adapter |
| `pulseaudio` | Audio routing |
| `pulseaudio-utils` | `pactl` (volume control) and `paplay` (sound playback) |
| `pulseaudio-module-bluetooth` | A2DP sink support for PulseAudio |
| `build-essential`, `python3` | Required to compile `rpio` native addon |

### pm2 Process Manager

After setup and first deploy, start the app:

```bash
pm2 start ~/code/dist/index.js --name radionette --cwd ~/code
pm2 save
```

(The `pm2` alias handles sudo and PATH automatically.)

pm2 creates a systemd service (`pm2-root`) that auto-starts on boot and resurrects the saved process list.

### Useful pm2 Commands

```bash
pm2 status                # Check app status
pm2 logs radionette       # Tail logs
pm2 restart radionette    # Restart after deploy
pm2 save                  # Save process list (after changes)
```

### PulseAudio

PulseAudio should run as the desktop user on login (default on Raspberry Pi OS with desktop). The app communicates with it using explicit socket/cookie paths detected at runtime. No extra PulseAudio configuration needed beyond installing `pulseaudio-module-bluetooth`.

### Directory Structure on Pi

```
~/code/
  dist/           # Compiled JS (deployed from dev machine)
    public/       # index.html, wifi.html
  assets/         # Sound files (bt-connect.wav, bt-ready.wav)
  channels.json   # Channel configuration
  wifi-fallback.sh # Boot fallback AP script
  package.json
  node_modules/   # Production dependencies (installed on Pi)
```

## GPIO Logger Utility

To map physical dial positions to channel numbers:

```bash
sudo ~/.nvm/versions/node/v24.14.1/bin/node dist/gpio-logger.js
```

Flip through all positions. Output shows raw value, binary, power/bt/channel fields. Ctrl+C to stop.

## Not Yet Implemented
- Volume control (waiting for ADC hardware)
