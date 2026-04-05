# Radionette

An internet radio built with a Raspberry Pi. Turn a physical dial to switch between radio stations. Flip to Bluetooth mode and it becomes a wireless speaker.

## What It Does

- **Radio mode:** A rotary dial switch selects from 15+ internet radio stations via GPIO. Audio plays through the Pi's 3.5mm jack or HDMI.
- **Bluetooth mode:** The Pi becomes a discoverable Bluetooth speaker called "Radionette" (with a speaker icon on your phone). Pair and stream music from any device.
- **Web status page:** A live dashboard at `http://radionette/` shows current station, now-playing metadata, and Bluetooth status. Tab navigation links to WiFi settings and a debug page.
- **WiFi configuration:** If the Pi can't connect to a known WiFi network at boot, it creates a hotspot (`Radionette-Setup`, password `radionette`). Connect to the hotspot and visit `http://10.42.0.1/wifi` to configure a network. WiFi settings are also always accessible at `http://radionette/wifi` when connected to the same network.
- **Debug page:** A live view of GPIO bit state, decoded bank/sub-channel values, full state dump, and grouped channel map at `http://radionette/debug`. Includes WiFi reset and system reboot controls.
- **Hotspot bleep alert:** When the Pi is in radio mode and the hotspot is active (no WiFi configured), a periodic bleep sounds through the speaker to alert the user to set up WiFi.
- **Auto-retry playback:** If the radio stream fails (e.g. no internet during hotspot mode), the player retries with escalating backoff (5s, 10s, 30s). Playback also resumes automatically when WiFi is configured via the settings page.

## Hardware

- Raspberry Pi 3 Model B
- Rotary dial switch wired to 10 GPIO input pins
- 2 LEDs (power + Bluetooth indicator)
- Audio output via 3.5mm jack or HDMI

### GPIO Pin Assignments

| Pin (BCM) | Direction | Function |
|---|---|---|
| 18 | Input | Channel bit 0 |
| 23 | Input | Channel bit 1 |
| 24 | Input | Channel bit 2 |
| 25 | Input | Channel bit 3 |
| 8 | Input | Channel bit 4 |
| 7 | Input | Channel bit 5 |
| 12 | Input | Channel bit 6 |
| 16 | Input | Channel bit 7 |
| 20 | Input | Bluetooth mode |
| 21 | Input | Power indicator |
| 11 | Output | Power LED |
| 26 | Output | Bluetooth LED |

All input pins use internal pull-down resistors.

## Raspberry Pi Setup

### 1. OS & Network

1. Flash **Raspberry Pi OS** (with desktop, for PulseAudio)
2. Set hostname to `radionette`
3. Enable SSH
4. Ensure the Pi is reachable as `ssh radionette` from your dev machine (via mDNS or SSH config)

### 2. Node.js

Install Node.js v24 via [nvm](https://github.com/nvm-sh/nvm):

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
source ~/.bashrc
nvm install v24.14.1
```

### 3. Automated Setup

The `setup-pi.sh` script handles everything else: system packages, Bluetooth configuration, pm2 installation, and boot persistence. Run it from your dev machine:

```bash
ssh radionette 'bash -s' < setup-pi.sh
```

This installs `mpg123`, `bluez`, `rfkill`, `pulseaudio` (+ Bluetooth module), `build-essential`, and `python3`. It configures the Bluetooth device class for the speaker icon, installs pm2, sets up auto-start on boot, and installs the wifi-fallback systemd service.

### 4. First Deploy

From your dev machine (requires Node.js and npm locally):

```bash
git clone <this-repo>
cd radionette
npm install
npm run deploy
```

This builds the TypeScript, syncs everything to the Pi, installs production dependencies, and restarts the app. The deploy script auto-detects the remote Node.js path.

Then on the Pi, start the app for the first time:

```bash
pm2 start ~/code/dist/index.js --name radionette --cwd ~/code
pm2 save
```

(The `pm2` alias was added to `~/.bashrc` by the setup script — it handles sudo and PATH automatically.)

### 5. Verify

- Open `http://radionette/` in a browser — you should see the status page
- Turn the dial — the station should change and audio should play
- Switch to Bluetooth mode — "Radionette" should appear as a speaker on your phone

## WiFi Configuration

The Radionette includes a built-in WiFi configuration system so you can set up the Pi's network connection without a keyboard or monitor.

### How It Works

1. **On boot**, the `wifi-fallback` systemd service waits 30 seconds for the Pi to connect to a known WiFi network.
2. **If no connection is established**, the Pi starts a WiFi hotspot:
   - **SSID:** `Radionette-Setup`
   - **Password:** `radionette`
3. **Connect** your phone or laptop to the hotspot, then open `http://10.42.0.1/wifi` in a browser.
4. **Select a network** from the scan list, enter the password, and tap Connect.
5. **The Pi connects** to the new network and the hotspot shuts down automatically. Reconnect your device to the same network and visit `http://radionette/` to verify.

### WiFi Settings Page

The WiFi settings page is always available at `http://radionette/wifi`, not just in hotspot mode. Use it to:
- View the current WiFi connection status
- Scan for available networks
- Connect to a different network

### API Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/wifi` | WiFi settings page |
| GET | `/debug` | Debug page (GPIO bits, state, channel map) |
| GET | `/api/wifi/status` | Current WiFi status (JSON) |
| GET | `/api/wifi/scan` | Scan for available networks (JSON) |
| POST | `/api/wifi/connect` | Connect to a network (`{ "ssid": "...", "password": "..." }`) |
| POST | `/api/system/wifi-reset` | Delete all saved WiFi networks and reboot |
| POST | `/api/system/reboot` | Reboot the Pi |

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

- **`deploy.sh`** — The `REMOTE` variable is set to `radionette` (SSH hostname). Change this to match your Pi's hostname or IP. The Node.js path is detected automatically.
- **`channels.json`** — Pre-configured with Norwegian radio stations (NRK, P4, etc.). Replace with your own station URLs.
- **`src/bluetooth.ts`** — PulseAudio paths are detected at runtime based on the OS user (via `SUDO_UID`/`SUDO_USER` env vars). No manual changes needed.

## Configuring Stations

Edit `channels.json` to add or change radio stations. Each entry maps a dial position (GPIO bits 0-7 decimal value) to a station:

```json
{
  "channels": {
    "192": { "name": "NRK P1", "url": "https://lyd.nrk.no/..." },
    "48":  { "name": "Radio Rock", "url": "https://live-bauerno.sharp-stream.com/..." }
  }
}
```

The channel number is composed of two nibbles: bits 7-4 select the bank, bits 3-0 select the sub-channel within the bank. See the debug page (`/debug`) for a visual breakdown.

## Project Structure

```
radionette/
  src/
    index.ts          # Entry point
    state.ts          # Central state machine + event emitter
    gpio.ts           # GPIO polling, debounce, LED control
    channels.ts       # Channel lookup from channels.json
    player.ts         # mpg123 child process management
    bluetooth.ts      # Bluetooth A2DP sink management
    wifi.ts           # WiFi scanning, connecting, hotspot (nmcli)
    hotspot-alert.ts  # Periodic bleep when hotspot is active in radio mode
    web.ts            # HTTP + WebSocket server
    public/
      index.html      # Status page (single-file, inline CSS/JS)
      wifi.html       # WiFi settings page (single-file, inline CSS/JS)
      debug.html      # Debug page (GPIO bits, state dump, channel map)
    gpio-logger.ts    # Utility for mapping dial positions
  assets/
    bt-connect.wav    # Sound: device connected
    bt-ready.wav      # Sound: BT mode active / device disconnected
    hotspot-bleep.wav # Sound: 880Hz tone + silence, loops while hotspot active
  channels.json       # Station configuration
  deploy.sh           # Build + deploy script
  setup-pi.sh         # One-time Pi setup script
  wifi-fallback.sh    # Boot script: start hotspot if no WiFi
  package.json
  tsconfig.json
```

## License

Private project.
