# Radionette

An internet radio built with a Raspberry Pi. Turn a physical dial to switch between radio stations. Flip to Bluetooth mode and it becomes a wireless speaker.

## What It Does

- **Radio mode:** A rotary dial switch selects from 15+ internet radio stations via GPIO. Audio plays through the Pi's 3.5mm jack or HDMI.
- **Bluetooth mode:** The Pi becomes a discoverable Bluetooth speaker called "Radionette" (with a speaker icon on your phone). Pair and stream music from any device.
- **Web status page:** A live dashboard at `http://radionette.local:8080/` shows current station, now-playing metadata, and Bluetooth status. Tab navigation links to WiFi settings and a debug page.
- **WiFi configuration:** If the Pi can't connect to a known WiFi network at boot, it creates an open hotspot (`Radionette-Setup`, no password). Connect to the hotspot and visit `http://10.42.0.1:8080/wifi` to configure a network. WiFi settings are also always accessible at `http://radionette.local:8080/wifi` when connected to the same network.
- **Debug page:** A live view of GPIO bit state, decoded bank/sub-channel values, full state dump, and grouped channel map at `http://radionette.local:8080/debug`. Includes a virtual dial for switching channels from the browser (with a reset-to-physical button), plus WiFi reset and system reboot controls.
- **Hotspot bleep alert:** When the Pi is in radio mode and the hotspot is active (no WiFi configured), a periodic bleep sounds through the speaker to alert the user to set up WiFi.
- **Auto-retry playback:** If the radio stream fails (e.g. no internet during hotspot mode), the player retries with escalating backoff (5s, 10s, 30s). Playback also resumes automatically when WiFi is configured via the settings page.

## Hardware

- Raspberry Pi 4 Model B
- Rotary dial switch wired to 10 GPIO input pins
- Mono/stereo switch on 1 GPIO input pin
- 2 LEDs (power + Bluetooth indicator)
- GC9A01 1.28" 240x240 round IPS display on SPI0
- ADS1115 16-bit ADC on I2C bus 1 for the volume potentiometer
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
     [PWR LED]  GP17 =| 11  12 |= GP18 [CH BIT 0]
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
| 17 | 11 | Out | Power LED |
| 26 | 37 | Out | Bluetooth LED |
| 13 | 33 | Out | Display backlight (MOSFET gate, on/off) |
| 8  | 24 | Out | Display CS (SPI0 CE0) |
| 11 | 23 | Out | Display SCLK (SPI0) |
| 10 | 19 | Out | Display MOSI (SPI0 DIN) |
| 27 | 13 | Out | Display D/C |
| 22 | 15 | Out | Display RESET |

### Display Wiring

Bare GC9A01 panel (14/15-pin variant). Backlight (LEDA) is switched by GPIO 13 through an N-channel MOSFET, so the panel goes dark when the radio is powered off.

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

**Backlight switching:** N-channel MOSFET (e.g. 2N7000, AO3400) — gate to GPIO 13 (Pi pin 33), source to GND, drain to LEDK; LEDA stays on 3V3. Alternatively a P-channel high-side switch on the LEDA rail. The `backlight.ts` module drives the gate on/off (no PWM) with a 10 s auto-off after the last user-visible event (channel change, BT device connect). Stays on while in BT search mode.

### Logo Assets

Channel and mode logos are PNG or animated GIF files in `assets/channel-logos/`. They're rendered at native size into a 240x240 round-masked frame ("contain" fit, centred, black corners).

- Reference channel logos from `channels.json` via the `logo` field, e.g. `"logo": "NRK-P1.png"`.
- Special filenames consumed by the display service:
  - `default.png` — fallback when a channel has no `logo` or the file is missing.
  - `bluetooth.png` — shown in BT mode while no device is connected.
  - `bluetooth-connected.png` — shown in BT mode while a device is connected.
- Animated GIFs play indefinitely; per-frame delays from the GIF are honoured (clamped to >=20 ms).
- Logos are cached in memory after first decode; restart radionette to pick up file changes.
- On every power-on, `default.png` is shown for 2 s before the channel/BT logo appears (a brief "splash" so the panel doesn't snap straight to content).

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

This installs nvm and Node.js LTS, then installs `mpg123`, `bluez`, `rfkill`, `pulseaudio` (+ Bluetooth module), `build-essential`, and `python3`. It configures the Bluetooth device class for the speaker icon, installs pm2, sets up auto-start on boot, and installs the wifi-fallback systemd service.

### 4. First Deploy

```bash
npm run deploy
```

This builds the TypeScript, syncs everything to the Pi, installs production dependencies, starts the app via pm2, and saves the process list. The deploy script auto-detects the remote Node.js path.

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
| GET | `/api/wifi/status` | Current WiFi status (JSON) |
| GET | `/api/wifi/scan` | Scan for available networks (JSON) |
| POST | `/api/wifi/connect` | Connect to a network (`{ "ssid": "...", "password": "..." }`) |
| POST | `/api/debug/gpio` | Inject a virtual GPIO value (`{ "value": 0-1023 }`) |
| POST | `/api/debug/gpio/reset` | Reset virtual dial override, revert to physical GPIO |
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

- **`deploy.sh`** — The `REMOTE` variable is set to `radionette.local` (mDNS hostname). Change this to match your Pi's hostname or IP. The Node.js path is detected automatically.
- **`channels.json`** — Pre-configured with Norwegian radio stations (NRK, P4, etc.). Replace with your own station URLs.
- **`src/bluetooth.ts`** — PulseAudio commands (`paplay`, `pactl`) run natively as the `pi` user. The `rfkill` command runs via `sudo`. No manual changes needed.

## Configuring Stations

Edit `channels.json` to add or change radio stations. Each entry maps a dial position (GPIO bits 0-7 decimal value) to a station:

```json
{
  "channels": {
    "192": { "name": "NRK P1", "url": "https://lyd.nrk.no/...", "logo": "NRK-P1.png" },
    "48":  { "name": "Radio Rock", "url": "https://live-bauerno.sharp-stream.com/...", "logo": "RadioRock.png" }
  }
}
```

The optional `logo` field is a filename (PNG or GIF) under `assets/channel-logos/`; if omitted or missing on disk, `default.png` is shown on the round display.

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
    audio.ts          # Mono/stereo mixing (PulseAudio remap-sink)
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
