# Radionette

An internet radio built with a Raspberry Pi. Turn a physical dial to switch between radio stations. Flip to Bluetooth mode and it becomes a wireless speaker.

## What It Does

- **Radio mode:** A rotary dial switch selects from 15+ internet radio stations via GPIO. Audio plays through the Pi's 3.5mm jack or HDMI.
- **Bluetooth mode:** The Pi becomes a discoverable Bluetooth speaker called "Radionette" (with a speaker icon on your phone). Pair and stream music from any device.
- **Web status page:** A live dashboard at `http://radionette/` shows current station, now-playing metadata, and Bluetooth status.

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
| 21 | Input | Power |
| 11 | Output | Power LED |
| 26 | Output | Bluetooth LED |

All input pins use internal pull-down resistors.

## Raspberry Pi Setup

### 1. OS & Network

1. Flash **Raspberry Pi OS** (with desktop, for PulseAudio)
2. Set hostname to `radionette`
3. Enable SSH
4. Ensure the Pi is reachable as `ssh radionette` from your dev machine (via mDNS or SSH config)

### 2. System Packages

```bash
sudo apt update
sudo apt install -y \
  mpg123 \
  bluez \
  rfkill \
  pulseaudio \
  pulseaudio-utils \
  pulseaudio-module-bluetooth \
  build-essential \
  python3
```

### 3. Node.js

Install Node.js v24 via [nvm](https://github.com/nvm-sh/nvm):

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
source ~/.bashrc
nvm install v24.14.1
```

### 4. Bluetooth Device Class

To show a **speaker icon** when phones discover "Radionette", edit `/etc/bluetooth/main.conf`:

```ini
[General]
Class = 0x240414
```

Then restart Bluetooth:
```bash
sudo systemctl restart bluetooth
```

### 5. First Deploy

From your dev machine (requires Node.js and npm locally):

```bash
git clone <this-repo>
cd radionette
npm install
npm run deploy
```

This builds the TypeScript, syncs everything to the Pi, installs production dependencies, and restarts the app.

### 6. pm2 (Process Manager)

pm2 keeps the app running and restarts it on crash or reboot.

```bash
# Install pm2 on the Pi
sudo env PATH=/home/pi/.nvm/versions/node/v24.14.1/bin:$PATH npm install -g pm2

# Start the app
sudo env PATH=/home/pi/.nvm/versions/node/v24.14.1/bin:$PATH \
  pm2 start ~/code/dist/index.js --name radionette --cwd ~/code

# Enable auto-start on boot
sudo env PATH=/home/pi/.nvm/versions/node/v24.14.1/bin:$PATH \
  pm2 startup systemd -u root --hp /root

# Save the process list
sudo env PATH=/home/pi/.nvm/versions/node/v24.14.1/bin:$PATH \
  pm2 save
```

**Tip:** Add this alias to `~/.bashrc` on the Pi:
```bash
alias pm2='sudo env PATH=/home/pi/.nvm/versions/node/v24.14.1/bin:$PATH pm2'
```

Then you can just use `pm2 status`, `pm2 logs radionette`, etc.

### 7. Verify

- Open `http://radionette/` in a browser — you should see the status page
- Turn the dial — the station should change and audio should play
- Switch to Bluetooth mode — "Radionette" should appear as a speaker on your phone

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

- **`deploy.sh`** — The `REMOTE` variable is set to `radionette` (SSH hostname). Change this to match your Pi's hostname or IP.
- **`channels.json`** — Pre-configured with Norwegian radio stations (NRK, P4, etc.). Replace with your own station URLs.
- **`src/bluetooth.ts`** — PulseAudio socket path assumes user `pi` (uid 1000). If your Pi uses a different username, update the `PULSE_ENV` paths.
- **pm2 commands in `deploy.sh`** — Reference the nvm Node.js path at `/home/pi/.nvm/versions/node/v24.14.1/bin`. Adjust if your Node version or username differs.

## Configuring Stations

Edit `channels.json` to add or change radio stations. Each entry maps a dial position (GPIO decimal value) to a station:

```json
{
  "channels": [
    { "number": 192, "name": "NRK P1", "url": "https://lyd.nrk.no/nrk_radio_p1_ostlandssendingen_mp3_h" },
    { "number": 48, "name": "Radio Rock", "url": "https://live-bauerno.sharp-stream.com/simulcast3_no.mp3" }
  ]
}
```

No rebuild needed — just edit the file and run `npm run deploy`.

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
    web.ts            # HTTP + WebSocket server
    public/
      index.html      # Status page (single-file, inline CSS/JS)
    gpio-logger.ts    # Utility for mapping dial positions
  assets/
    bt-connect.wav    # Sound: device connected
    bt-ready.wav      # Sound: BT mode active / device disconnected
  channels.json       # Station configuration
  deploy.sh           # Build + deploy script
  package.json
  tsconfig.json
```

## License

Private project.
