# Radionette

Internet radio controller for Raspberry Pi 4 Model B. Reads physical radio dial position via GPIO, plays internet radio streams, serves a live web status page, and acts as a Bluetooth A2DP audio sink.

## Architecture

### Hardware
- **Raspberry Pi 4 Model B**
- **11 GPIO input pins** from a physical rotary dial switch and mono switch
  - Bits 0-7 (GPIO 18, 23, 24, 25, 8, 7, 12, 16): Channel selector — 15 unique positions across two banks
  - Bit 8 (GPIO 20): Bluetooth indicator
  - Bit 9 (GPIO 21): Power indicator
  - Bit 10 (GPIO 19): Mono switch (HIGH = mono, LOW = stereo)
- **2 GPIO output pins** for indicator LEDs
  - GPIO 11: Power LED
  - GPIO 26: Bluetooth LED
- Audio output via 3.5mm jack or HDMI
- **ADS1115 16-bit ADC** on I2C bus 1 (address 0x48) — reads volume potentiometer on channel A0

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
| `src/index.ts` | Entry point — wires modules: channels -> player -> bluetooth -> hotspot-alert -> web -> gpio |
| `src/state.ts` | Central state singleton + EventEmitter. All modules communicate through this. |
| `src/gpio.ts` | Reads 11 input pins every 10ms, debounces (50ms), drives state machine, controls LED outputs. Falls back to dev mode when rpio unavailable. Exports `injectGpioValue()` for virtual dial API and `resetGpioOverride()` to revert to physical pins. |
| `src/channels.ts` | Loads `channels.json` at startup. Looks up channel number -> name + URL. |
| `src/player.ts` | Spawns/kills `/usr/bin/mpg123` child processes. Parses ICY stream metadata. Reacts to state events. Auto-retries with escalating backoff (5s, 10s, 30s) when stream fails and desired channel is still set. |
| `src/bluetooth.ts` | Full Bluetooth A2DP sink management — enable/disable adapter, pairing agent, device monitoring, volume boost, flap detection, auto-reconnect, notification sounds. |
| `src/audio.ts` | Mono/stereo audio mixing via PulseAudio `module-remap-sink`. Creates per-sink remap-sinks for all real sinks (ALSA + BT). Spawns `pactl subscribe` to dynamically handle new BT sinks and new sink-inputs. Listens for `mono:on`/`mono:off` events from GPIO. |
| `src/volume.ts` | Volume control via I2C ADS1115 ADC. Polls potentiometer every 100ms, applies 10-sample rolling average for smoothing, sets PulseAudio master volume on all sinks via `pactl set-sink-volume`. Re-applies volume on mode changes (BT connect/disconnect). Falls back to dev mode when `ioctl` module or `/dev/i2c-1` is unavailable. |
| `src/web.ts` | HTTP server (port 8080) + WebSocket. Serves status page, WiFi settings page, and WiFi API endpoints. System management endpoints (WiFi reset, reboot). Pushes live state to all connected clients. |
| `src/wifi.ts` | WiFi management via `nmcli` — scan for networks, connect (triggers playback retry on success), start/stop hotspot, hotspot detection, WiFi reset, system reboot. Write operations use `sudo nmcli`. Falls back to mock data in dev mode. |
| `src/hotspot-alert.ts` | Periodic bleep alert when hotspot is active in radio mode. Uses `aplay` (ALSA) for early-boot compatibility before PulseAudio starts. Polls hotspot status every 5s, loops `hotspot-bleep.wav` via aplay. |
| `src/public/index.html` | Single-file status page with inline CSS/JS. Dark theme (neutral grey palette via CSS custom properties), live WebSocket updates, tab navigation (Status / WiFi / Debug). Channel list grouped by bank with bank headers. |
| `src/public/wifi.html` | Single-file WiFi settings page with inline CSS/JS. Same dark theme, tab navigation. Network scan list with signal bars, connect modal with password field, AP-mode warning. |
| `src/public/debug.html` | Single-file debug page with inline CSS/JS. Same dark theme, tab navigation. Color-coded GPIO bit display (green=power, blue=bluetooth, amber=bank/sub), decoded bank/sub values, virtual dial controls (PWR, BT, Bank, Sub buttons that inject GPIO values via API — physical dial overrides, reset-to-physical button clears override), channel info table, full state dump table, grouped channel map. System card with WiFi reset and reboot buttons. Live WebSocket updates. |
| `src/gpio-logger.ts` | Standalone utility — logs raw GPIO values on change for mapping physical dial positions. |
| `channels.json` | Channel configuration — maps dial position numbers to station name + stream URL. Edit this to change stations. |
| `wifi-fallback.sh` | Boot script — waits 30s for WiFi, starts hotspot if no connection. Installed as a systemd service by `setup-pi.sh`. |
| `assets/bt-connect.wav` | Ascending two-tone chime played when a Bluetooth device connects. |
| `assets/bt-ready.wav` | Soft single tone played when BT mode activates or a device disconnects. |
| `assets/hotspot-bleep.wav` | 880Hz tone followed by 3s silence. Loops via aplay when hotspot is active in radio mode. |

### Event Flow

```
GPIO poll (10ms) -> debounce (50ms) -> state.ts EventEmitter
  |- player.ts listens        -> spawns/kills mpg123 (with auto-retry on failure)
  |- bluetooth.ts listens     -> enables/disables BT adapter
  |- audio.ts listens         -> loads/unloads per-sink PulseAudio mono remap-sinks, watches for new sinks/inputs
  |- hotspot-alert.ts listens -> bleeps when hotspot active in radio mode
  +- web.ts listens           -> broadcasts to WebSocket clients
```

Events emitted by state.ts:
- `power:on` / `power:off`
- `mode:bluetooth` / `mode:radio`
- `channel:change` (with channel info)
- `player:playing` / `player:stopped`
- `player:metadata` (ICY stream info)
- `mono:on` / `mono:off`
- `state:change` (full state snapshot, used by web)

### Channel Config

`channels.json` maps GPIO bits 0-7 decimal values to streams. The channel number is composed of two nibbles:

- **Bits 7-4:** Bank selector (hardware value -> label)
  - `12` (0b1100) = Bank 1: NRK P1, P1+, P2, Klassisk, Nyheter
  - `8` (0b1000) = Bank 2: NRK P3, P3 Musikk, P13, mP3, Jazz
  - `10` (0b1010) = Bank 3: NRK Folkemusikk, Sámi Radio, P4, P5, P7
  - `3` (0b0011) = Bank 4: Radio Rock, IRock 247, P11 Bandit, NRJ, P10 Country

- **Bits 3-0:** Sub-channel selector (hardware value -> label)
  - `0` (0b0000) = Sub 1
  - `1` (0b0001) = Sub 2
  - `8` (0b1000) = Sub 3
  - `10` (0b1010) = Sub 4
  - `12` (0b1100) = Sub 5

Example: Channel key `192` = 0b**1100**_0000 = Bank 1 (`12`), Sub 1 (`0`) = NRK P1.

Add any HTTP/MP3 stream URL. No rebuild needed — just edit the file and restart.

### Player Details

The player module (`src/player.ts`) manages mpg123 child processes with serialized operations:

- **Serialized play/stop:** All operations go through a promise chain (`pendingOperation`) to prevent overlapping spawns
- **ICY metadata parsing:** Extracts `StreamTitle` from mpg123 stdout/stderr output
- **Auto-retry on failure:** When mpg123 exits unexpectedly and `desiredChannel` is still set, retries with escalating backoff:
  - Delays: 5s → 10s → 30s (caps at 30s for subsequent retries)
  - Retries are cancelled on explicit stop, power off, mode switch, or channel change
  - `retryCount` resets to 0 when a new channel is selected
- **Playback resume after WiFi:** `state.ts` exposes `retryPlayback()` which re-emits `channel:change` if in radio mode with a channel selected but not playing. Called from `wifi.ts` after successful `connectToNetwork()`.

Uses absolute path `/usr/bin/mpg123`.

### Bluetooth Details

The Bluetooth module (`src/bluetooth.ts`) manages:

- **Adapter control:** `sudo rfkill unblock` + `bluetoothctl power on/off`
- **Discoverable name:** "Radionette" (set via `bluetoothctl system-alias`)
- **Device class:** `0x240414` (Loudspeaker) — configured in `/etc/bluetooth/main.conf`, shows speaker icon on phones
- **Pairing agent:** `DisplayYesNo` with auto-accept — handles iPhone passkey confirmation prompts
- **Volume boost:** BT audio sink-inputs boosted to 120% via `pactl set-sink-input-volume`
- **Flap detection:** 3 disconnects in 10 seconds -> device removed from BlueZ, 30s cooldown
- **Auto-reconnect:** Reconnects to last stable device (connected >5s) when BT mode re-enabled
- **Notification sounds:** `bt-connect.wav` and `bt-ready.wav` played via `paplay`

All system binaries use absolute paths (`/usr/sbin/rfkill`, `/usr/bin/bluetoothctl`, `/usr/bin/pactl`, `/usr/bin/paplay`) because pm2 runs with a minimal PATH. `rfkill` is run via `sudo` because `/dev/rfkill` is not writable by the `pi` user.

The app runs as the `pi` user, which owns the PulseAudio session. `paplay` and `pactl` connect natively without any `sudo` wrapper. PulseAudio starts via socket activation on headless Pi (no desktop).

### Audio Details

The audio module (`src/audio.ts`) provides mono/stereo switching via PulseAudio with dynamic per-sink remap:

- **Per-sink remap:** Creates a `module-remap-sink` for **every** real sink (ALSA hardware + any Bluetooth sinks). Each remap-sink is named `mono_mix_<realSinkName>` and downmixes stereo L+R into mono with `channels=1 channel_map=mono remix=yes`
- **GPIO-controlled:** BCM pin 19 with pull-down resistor. HIGH = mono, LOW = stereo (default)
- **Dynamic BT sink handling:** Spawns `pactl subscribe` to watch PulseAudio events. When a new sink appears (e.g. Bluetooth device connects while mono is active), automatically creates a remap-sink for it and moves its streams
- **Auto sink-input routing:** The subscribe watcher also detects new sink-inputs (e.g. mpg123 starts, BT audio arrives) and moves them to the corresponding mono remap-sink
- **Live switching:** On `mono:on`, creates remap-sinks for all current sinks, sets the mono version of the default sink as the new default, and moves all active streams. On `mono:off`, moves streams back to real sinks, unloads all remap modules, restores the original default sink, and kills the subscribe watcher
- **Cleanup on sink removal:** When a master sink is removed (BT disconnect), PulseAudio auto-unloads its remap module; the module map is cleaned up on next `disableMono()`

Uses absolute path `/usr/bin/pactl`.

### Volume Details

The volume module (`src/volume.ts`) reads a potentiometer via an ADS1115 16-bit ADC over I2C and controls PulseAudio master volume:

- **Hardware:** ADS1115 on I2C bus 1 (`/dev/i2c-1`), address `0x48`, channel A0 (single-ended vs GND)
- **I2C access:** Uses raw file I/O on `/dev/i2c-1` with the `ioctl` npm module to set the slave address (native addon, like `rpio`)
- **ADC config:** Continuous mode, PGA +/-4.096V (FS), 128 SPS. Writes config register once at init, then reads conversion register every poll
- **Pot calibration:** Raw range 0-14300 (pot only outputs ~0-1.8V). Wiring is inverted (high=off), corrected in software
- **Smoothing:** 10-sample rolling average to tame noisy 70-year-old pot. Buffer pre-seeded at init to avoid ramp-up
- **Volume control:** Sets PulseAudio volume on ALL sinks via `pactl set-sink-volume` when smoothed percent changes by >= 1%. Linear curve
- **New sinks:** Re-applies volume on `mode:bluetooth` / `mode:radio` state events (covers BT connect/disconnect)
- **State integration:** Calls `radioState.setVolume()` which emits `volume:change` + `state:change` (broadcast to web UI)
- **Log debouncing:** Raw ADC and volume-set logs throttled to max 1/sec to reduce log spam
- **Polling:** Reads ADC every 100ms
- **Dev mode:** Falls back silently when `ioctl` module is unavailable (dev machine) or `/dev/i2c-1` doesn't exist

Requires I2C enabled on the Pi (`sudo raspi-config` -> Interface Options -> I2C -> Enable).

### WiFi Details

The WiFi module (`src/wifi.ts`) provides:

- **Network scanning:** `nmcli device wifi list` with deduplication and signal sorting
- **Connecting:** `nmcli device wifi connect` — stops hotspot first if active, restarts it if connection fails. Calls `radioState.retryPlayback()` on success to resume radio playback.
- **Hotspot:** Open AP (no password) via `nmcli connection add` — SSID `Radionette-Setup`, connection name `radionette-hotspot`.
- **Hotspot detection:** `isHotspotActive()` uses `nmcli -t device status` to check if wlan0 is connected to `radionette-hotspot` (works even without connected clients, unlike `nmcli connection show --active`)
- **WiFi reset:** `resetWifiConfig()` deletes all saved WiFi connection profiles via `nmcli connection delete` and reboots
- **System reboot:** `rebootSystem()` calls `sudo /usr/bin/systemctl reboot`
- **Status:** Reads wlan0 device state via `nmcli device show`
- **Dev mode:** If `nmcli` is unavailable (laptop), returns mock data

Uses absolute path `/usr/bin/nmcli`. Write operations (`connect`, `add`, `delete`, `up`, `down`) run via `sudo nmcli` since the `pi` user lacks polkit authorization for non-interactive NetworkManager writes. Read operations (`status`, `scan`, `list`, `show`) run without sudo. The hotspot connection profile (`radionette-hotspot`) is deleted on stop to avoid accumulating stale profiles.

**WiFi fallback boot service:**
- `wifi-fallback.sh` runs at boot via `wifi-fallback.service` (systemd, oneshot)
- Waits up to 30 seconds (checking every 5s) for wlan0 to connect
- If no connection, starts the hotspot via nmcli
- Logs to systemd journal (`logger -t wifi-fallback`)

**API endpoints** (served by `src/web.ts`):

| Method | Path | Description |
|---|---|---|
| GET | `/wifi` | WiFi settings HTML page |
| GET | `/debug` | Debug HTML page |
| GET | `/api/wifi/status` | JSON: `{ connected, ssid, ip, hotspotActive }` |
| GET | `/api/wifi/scan` | JSON: `[{ ssid, signal, security, active }]` |
| POST | `/api/wifi/connect` | JSON body: `{ ssid, password }` → `{ success, error? }` |
| POST | `/api/debug/gpio` | JSON body: `{ value }` (0-2047) → injects synthetic GPIO value. Physical dial overrides on next change. |
| POST | `/api/debug/gpio/reset` | Clears virtual dial override, reverts to physical GPIO pin state. |
| POST | `/api/system/wifi-reset` | Delete all saved WiFi networks and reboot |
| POST | `/api/system/reboot` | Reboot the Pi |

**Compatibility:** The CYW43455 WiFi chip on the Pi 4 supports AP mode with WPA, though the hotspot currently uses an open network for simplicity. Both Pi 3 and Pi 4 support simultaneous AP + managed on the same channel, but the implementation uses a simpler approach: stop AP -> connect -> restart AP if connection fails.

### Hotspot Alert Details

The hotspot alert module (`src/hotspot-alert.ts`) provides an audible notification when the Pi is in radio mode but has no WiFi configured (hotspot is active):

- **Polling:** Checks `isHotspotActive()` every 5 seconds when in radio mode
- **Bleep loop:** Plays `hotspot-bleep.wav` (880Hz tone + 3s silence) in a continuous loop via `aplay`
- **ALSA, not PulseAudio:** Uses `/usr/bin/aplay` instead of `paplay` because the hotspot bleep needs to work at early boot before the PulseAudio session starts
- **Lifecycle:** Starts polling on `mode:radio`, stops on `mode:bluetooth` or `power:off`
- **Error handling:** Delays 5s before retrying if `aplay` fails, to avoid tight spin loops

### Web UI Conventions

All HTML pages are single-file with inline CSS and JS (no external dependencies). They share:

- **Dark theme** with neutral grey palette via CSS custom properties in `:root`:
  ```css
  --bg: #1a1a1a; --bg-card: #252525; --bg-hover: #2e2e2e;
  --border: #333; --text: #ddd; --text-sec: #999;
  --text-muted: #777; --text-dim: #666; --dot-off: #4a4a4a;
  --accent: #7daf8b; --accent-bg: #2a3a2e; --blue: #6b8db5;
  --red: #c0392b; --red-bg: #3a2a2a; --amber: #c9a84c; --amber-bg: #332e1a;
  ```
- **Tab navigation** below the title: `Status | WiFi | Debug` — active tab highlighted in `--accent` with underline
- **Title:** `<h1><a href="/">RADIONETTE</a></h1>` (white `#fff`)
- **Cards:** `.status-card` or `.card` class — dark card with rounded corners and border
- **Channel lists** are sorted and grouped by bank (1-4) with amber bank headers, sub-channel number (1-5) shown instead of raw GPIO values

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
npm run deploy       # Builds, rsyncs to pi@radionette.local:~/code/, installs deps, restarts pm2
```

The deploy script (`deploy.sh`) does:
1. `npm run build` (TypeScript -> JS)
2. rsync `dist/` to Pi (with `--delete`)
3. rsync `channels.json`, `package.json`, `package-lock.json` to Pi
4. rsync `src/public/` to `dist/public/` on Pi (HTML not handled by tsc)
5. rsync `assets/` to Pi (sound files)
6. rsync `wifi-fallback.sh` to Pi (+ chmod +x)
7. `npm install --omit=dev` on Pi (compiles native `rpio` addon)
8. `pm2 restart radionette` (or `pm2 start` on first deploy) + `pm2 save`

## Raspberry Pi Setup

### Prerequisites

- Raspberry Pi 4 Model B with Raspberry Pi OS
- Hostname set to `radionette`
- SSH enabled, accessible as `ssh pi@radionette.local` from dev machine
- Logged in as the `pi` user

### Automated Setup

Run `setup-pi.sh` from the dev machine to install nvm, Node.js LTS, all system packages, configure Bluetooth, install pm2, and set up boot persistence:

```bash
npm run setup-pi
```

The script requires the `pi` user and will fail otherwise. It auto-installs nvm and Node.js LTS if not already present.

### What setup-pi.sh does

1. **Pi user check:** Fails if not running as `pi`
2. **nvm + Node.js:** Installs nvm and Node.js LTS if not already present
3. **System packages:** `mpg123`, `bluez`, `rfkill`, `pulseaudio` (+ bluetooth module), `build-essential`, `python3`
4. **Bluetooth device class:** Sets `Class = 0x240414` in `/etc/bluetooth/main.conf` (speaker icon)
5. **pm2:** Installs via nvm (as pi user, not root), writes systemd service file directly (avoids `pm2 startup` which crashes with EIO errors)
6. **Environment:** `XDG_RUNTIME_DIR` and `PM2_HOME` are set directly in the pm2 service file; user linger enabled for boot-time `/run/user/1000`
7. **WiFi fallback:** Installs `wifi-fallback.service` systemd unit pointing to `~/code/wifi-fallback.sh`, enables it for boot

| Package | Purpose |
|---|---|
| `mpg123` | Internet radio stream playback |
| `bluez` | Bluetooth stack (`bluetoothctl`) |
| `rfkill` | Block/unblock Bluetooth adapter |
| `pulseaudio` | Audio routing |
| `pulseaudio-utils` | `pactl` (volume control) and `paplay` (sound playback) |
| `pulseaudio-module-bluetooth` | A2DP sink support for PulseAudio |
| `build-essential`, `python3` | Required to compile `rpio` and `ioctl` native addons |
| `i2c-tools` | `i2cdetect` for debugging ADS1115 ADC connection |

### pm2 Process Manager

The first `npm run deploy` automatically starts the app via pm2 and saves the process list. Subsequent deploys restart the existing process.

pm2's systemd service (`pm2-pi`) is written directly by `setup-pi.sh` (not generated by `pm2 startup`, which crashes with EIO errors on fresh Pi OS). The service auto-starts on boot and resurrects the saved process list. It runs as the `pi` user (not root). `XDG_RUNTIME_DIR` and `PM2_HOME` are set in the service file so PulseAudio can find the user session socket.

### Useful pm2 Commands

```bash
pm2 status                # Check app status
pm2 logs radionette       # Tail logs
pm2 restart radionette    # Restart after deploy
pm2 save                  # Save process list (after changes)
```

### PulseAudio

PulseAudio runs as the `pi` user. Since the app also runs as `pi`, PulseAudio commands (`paplay`, `pactl`) work natively without any wrappers. On headless Pi, PulseAudio starts via socket activation when first needed. No extra PulseAudio configuration needed beyond installing `pulseaudio-module-bluetooth`.

### Directory Structure on Pi

```
~/code/
  dist/           # Compiled JS (deployed from dev machine)
    public/       # index.html, wifi.html, debug.html
  assets/         # Sound files (bt-connect.wav, bt-ready.wav, hotspot-bleep.wav)
  channels.json   # Channel configuration
  wifi-fallback.sh # Boot fallback AP script
  package.json
  node_modules/   # Production dependencies (installed on Pi)
```

## GPIO Logger Utility

To map physical dial positions to channel numbers:

```bash
node dist/gpio-logger.js
```

Flip through all positions. Output shows raw value, binary, power/bt/channel fields. Ctrl+C to stop.

## Not Yet Implemented
- (none currently)
