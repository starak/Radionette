#!/bin/bash
# setup-pi.sh — One-time setup for a new Raspberry Pi running Radionette.
#
# Prerequisites:
#   - Raspberry Pi OS (with desktop, for PulseAudio) flashed and SSH enabled
#   - Hostname set to "radionette"
#   - Node.js installed (v24.14.1 via nvm)
#
# Usage (from your dev machine):
#   ssh radionette 'bash -s' < setup-pi.sh
#
# Or copy to the Pi and run directly:
#   scp setup-pi.sh radionette:~ && ssh radionette 'bash ~/setup-pi.sh'

set -euo pipefail

# ---------- helpers ----------

info()  { echo -e "\n\033[1;34m==>\033[0m \033[1m$*\033[0m"; }
ok()    { echo -e "    \033[1;32m✓\033[0m $*"; }
warn()  { echo -e "    \033[1;33m!\033[0m $*"; }
fail()  { echo -e "    \033[1;31m✗\033[0m $*"; exit 1; }

# ---------- detect environment ----------

CURRENT_USER=$(whoami)

# nvm is only loaded in interactive shells — source it explicitly
export NVM_DIR="${HOME}/.nvm"
if [ -s "${NVM_DIR}/nvm.sh" ]; then
  . "${NVM_DIR}/nvm.sh"
fi

NODE_BIN=$(dirname "$(which node 2>/dev/null)" 2>/dev/null || true)

if [ -z "${NODE_BIN}" ]; then
  fail "Node.js not found. Install it first via nvm: nvm install v24.14.1"
fi

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

info "Installing pm2 globally..."
sudo env "PATH=${NODE_BIN}:$PATH" npm install -g pm2
ok "pm2 installed"

# ---------- 5. pm2 startup service ----------

info "Configuring pm2 startup on boot..."
sudo env "PATH=${NODE_BIN}:$PATH" pm2 startup systemd -u root --hp /root
ok "pm2 startup service configured"

# ---------- 6. Add pm2 alias to .bashrc ----------

info "Adding pm2 alias to ~/.bashrc..."
PM2_ALIAS="alias pm2='sudo env PATH=${NODE_BIN}:\$PATH pm2'"
if grep -qF "alias pm2=" ~/.bashrc 2>/dev/null; then
  # Update existing alias
  sed -i "s|^alias pm2=.*|${PM2_ALIAS}|" ~/.bashrc
  ok "Updated existing pm2 alias"
else
  echo "" >> ~/.bashrc
  echo "# Radionette: pm2 alias (runs as root with nvm Node in PATH)" >> ~/.bashrc
  echo "${PM2_ALIAS}" >> ~/.bashrc
  ok "Added pm2 alias to ~/.bashrc"
fi

# ---------- 7. WiFi fallback hotspot service ----------

info "Installing wifi-fallback systemd service..."

FALLBACK_SCRIPT="${HOME}/code/wifi-fallback.sh"
FALLBACK_SERVICE="/etc/systemd/system/wifi-fallback.service"

if [ ! -f "${FALLBACK_SCRIPT}" ]; then
  warn "${FALLBACK_SCRIPT} not found — deploy the app first, then re-run setup"
else
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
fi

# ---------- summary ----------

info "Setup complete!"
echo ""
echo "  Next steps:"
echo "  1. From your dev machine, run: npm run deploy"
echo "  2. Then on the Pi, start the app for the first time:"
echo "     sudo env PATH=${NODE_BIN}:\$PATH pm2 start ~/code/dist/index.js --name radionette --cwd ~/code"
echo "     sudo env PATH=${NODE_BIN}:\$PATH pm2 save"
echo "  3. Open http://radionette/ in a browser to verify"
echo ""
