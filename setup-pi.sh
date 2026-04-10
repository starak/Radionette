#!/bin/bash
# setup-pi.sh — One-time setup for a new Raspberry Pi running Radionette.
#
# Prerequisites:
#   - Raspberry Pi OS flashed and SSH enabled
#   - Hostname set to "radionette"
#   - Logged in as the "pi" user
#
# Usage (from your dev machine):
#   ssh pi@radionette.local 'bash -s' < setup-pi.sh
#
# Or copy to the Pi and run directly:
#   scp setup-pi.sh pi@radionette.local:~ && ssh pi@radionette.local 'bash ~/setup-pi.sh'

set -euo pipefail

# ---------- helpers ----------

info()  { echo -e "\n\033[1;34m==>\033[0m \033[1m$*\033[0m"; }
ok()    { echo -e "    \033[1;32m✓\033[0m $*"; }
warn()  { echo -e "    \033[1;33m!\033[0m $*"; }
fail()  { echo -e "    \033[1;31m✗\033[0m $*"; exit 1; }

# ---------- require pi user ----------

CURRENT_USER=$(whoami)
if [ "${CURRENT_USER}" != "pi" ]; then
  fail "This script must be run as the 'pi' user (currently: ${CURRENT_USER})"
fi

# ---------- install nvm + Node.js ----------

export NVM_DIR="${HOME}/.nvm"

if [ ! -s "${NVM_DIR}/nvm.sh" ]; then
  info "Installing nvm..."
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
  ok "nvm installed"
fi

# Source nvm (needed in non-interactive shells)
. "${NVM_DIR}/nvm.sh"

if ! command -v node &>/dev/null; then
  info "Installing Node.js LTS..."
  nvm install --lts
  ok "Node.js LTS installed"
else
  ok "Node.js already installed: $(node --version)"
fi

# ---------- detect environment ----------

NODE_BIN=$(dirname "$(which node)")
NODE_VERSION=$(node --version)
info "Detected environment"
ok "User: ${CURRENT_USER}"
ok "Home: ${HOME}"
ok "Node: ${NODE_VERSION} (${NODE_BIN})"

# ---------- 1. System packages ----------

info "Installing system packages..."
sudo apt-get update -qq
sudo apt-get install -y -qq \
  mpg123 \
  bluez \
  rfkill \
  pulseaudio \
  pulseaudio-utils \
  pulseaudio-module-bluetooth \
  i2c-tools \
  build-essential \
  python3
ok "System packages installed"

# ---------- 2. Bluetooth device class ----------

info "Configuring Bluetooth device class (speaker icon)..."


BT_CONF="/etc/bluetooth/main.conf"
if [ ! -f "${BT_CONF}" ]; then
  warn "${BT_CONF} not found — skipping (bluez may not be configured yet)"
else
  # Check if Class is already set correctly
  if grep -q "^Class\s*=\s*0x240414" "${BT_CONF}" 2>/dev/null; then
    ok "Bluetooth Class already set to 0x240414"
  else
    # Add or update Class under [General]
    if grep -q "^\[General\]" "${BT_CONF}"; then
      # Remove any existing Class line and add the correct one after [General]
      sudo sed -i '/^Class\s*=/d' "${BT_CONF}"
      sudo sed -i '/^\[General\]/a Class = 0x240414' "${BT_CONF}"
    else
      # No [General] section — append one
      echo -e "\n[General]\nClass = 0x240414" | sudo tee -a "${BT_CONF}" > /dev/null
    fi
    ok "Set Bluetooth Class = 0x240414 in ${BT_CONF}"
    sudo systemctl restart bluetooth
    ok "Bluetooth service restarted"
  fi
fi

# ---------- 3. Create code directory ----------

info "Creating ~/code directory..."
mkdir -p ~/code
ok "~/code exists"

# ---------- 4. Install pm2 ----------

info "Installing pm2..."
# Install as the pi user (not with sudo) — running pm2 as root tries to
# create /root/.pm2 which fails on some Pi OS images with I/O errors.
npm install -g pm2
ok "pm2 installed at ${NODE_BIN}/pm2"

# ---------- 5. pm2 startup service ----------

info "Installing pm2 systemd service..."

# Write the service file directly instead of using 'pm2 startup'.
# 'pm2 startup systemd' runs pm2 as root during generation, which crashes
# on fresh Pi OS because it can't create /root/.pm2 (EIO errors).
# We know exactly what the service needs, so write it ourselves.
PM2_SERVICE="pm2-${CURRENT_USER}.service"
PM2_SERVICE_FILE="/etc/systemd/system/${PM2_SERVICE}"

sudo tee "${PM2_SERVICE_FILE}" > /dev/null <<EOF
[Unit]
Description=PM2 process manager for ${CURRENT_USER}
Documentation=https://pm2.keymetrics.io/
After=network.target

[Service]
Type=forking
User=${CURRENT_USER}
LimitNOFILE=infinity
LimitNPROC=infinity
LimitCORE=infinity
Environment=PATH=${NODE_BIN}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Environment=PM2_HOME=${HOME}/.pm2
Environment=XDG_RUNTIME_DIR=/run/user/$(id -u)
PIDFile=${HOME}/.pm2/pm2.pid
Restart=on-failure

ExecStart=${NODE_BIN}/pm2 resurrect
ExecReload=${NODE_BIN}/pm2 reload all
ExecStop=${NODE_BIN}/pm2 kill

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable "${PM2_SERVICE}"
ok "${PM2_SERVICE} installed and enabled"

# ---------- 6. Enable user linger ----------

info "Enabling user linger for ${CURRENT_USER}..."
# User lingering ensures /run/user/<uid> is created at boot (before login).
# Without this, PulseAudio socket activation fails because XDG_RUNTIME_DIR
# doesn't exist yet when pm2 starts.
sudo loginctl enable-linger "${CURRENT_USER}"
ok "User linger enabled for ${CURRENT_USER}"

# ---------- 7. WiFi fallback hotspot service ----------

info "Installing wifi-fallback systemd service..."

FALLBACK_SCRIPT="${HOME}/code/wifi-fallback.sh"
FALLBACK_SERVICE="/etc/systemd/system/wifi-fallback.service"

# Always install the service file, even if wifi-fallback.sh hasn't been
# deployed yet.  The service will simply fail (harmlessly) on boot until
# the first `npm run deploy` copies the script into place.
sudo tee "${FALLBACK_SERVICE}" > /dev/null <<EOF
[Unit]
Description=WiFi fallback hotspot for Radionette
After=NetworkManager.service
Wants=NetworkManager.service

[Service]
Type=oneshot
ExecStart=${FALLBACK_SCRIPT}
RemainAfterExit=no

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable wifi-fallback.service
ok "wifi-fallback.service installed and enabled"

if [ ! -f "${FALLBACK_SCRIPT}" ]; then
  warn "${FALLBACK_SCRIPT} not found yet — run 'npm run deploy' to activate the service"
fi

# ---------- summary ----------

info "Setup complete!"
echo ""
echo "  Next steps:"
echo "  1. From your dev machine, run: npm run deploy"
echo "  2. Open http://radionette.local:8080/ in a browser to verify"
echo ""
