#!/bin/bash
set -e

REMOTE="pi@radionette.local"
REMOTE_DIR="~/code"

# Parse flags
FORCE_INSTALL=0
WIPE_MODULES=0
for arg in "$@"; do
  case "${arg}" in
    --install) FORCE_INSTALL=1 ;;
    --refresh) FORCE_INSTALL=1; WIPE_MODULES=1 ;;
    *) echo "Unknown flag: ${arg}"; exit 1 ;;
  esac
done

# Detect the remote user's nvm Node.js path dynamically.
# nvm is only loaded in interactive shells, so source it explicitly.
NODE_BIN=$(ssh "${REMOTE}" 'export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"; echo $(dirname $(which node))')
if [ -z "${NODE_BIN}" ]; then
  echo "Error: Could not detect Node.js path on ${REMOTE}. Is Node.js installed?"
  exit 1
fi
echo "Detected Node.js on ${REMOTE}: ${NODE_BIN}"

echo "Building TypeScript..."
npm run build

echo "Syncing to ${REMOTE}:${REMOTE_DIR}..."
rsync -avz --delete \
  dist/ \
  "${REMOTE}:${REMOTE_DIR}/dist/"

rsync -avz \
  channels.json \
  package.json \
  package-lock.json \
  "${REMOTE}:${REMOTE_DIR}/"

# Copy the HTML file (not compiled by tsc)
rsync -avz \
  src/public/ \
  "${REMOTE}:${REMOTE_DIR}/dist/public/"

# Copy sound assets
rsync -avz \
  assets/ \
  "${REMOTE}:${REMOTE_DIR}/assets/"

# Copy wifi-fallback script
rsync -avz \
  wifi-fallback.sh \
  "${REMOTE}:${REMOTE_DIR}/wifi-fallback.sh"
ssh "${REMOTE}" "chmod +x ${REMOTE_DIR}/wifi-fallback.sh"

#echo "Installing dependencies on Pi..."
#ssh "${REMOTE}" "export NVM_DIR=\$HOME/.nvm; [ -s \$NVM_DIR/nvm.sh ] && . \$NVM_DIR/nvm.sh; cd ${REMOTE_DIR} && npm install --omit=dev && npm rebuild"

# Auto-install deps if node_modules is missing/empty on the Pi, or if --install was passed.
# --foreground-scripts ensures native builds (spi-device, rpio, canvas, ioctl) actually execute
# instead of being silently skipped by npm's install-script safety block.
NEEDS_INSTALL=$(ssh "${REMOTE}" "if [ ! -d ${REMOTE_DIR}/node_modules ] || [ -z \"\$(ls -A ${REMOTE_DIR}/node_modules 2>/dev/null)\" ]; then echo 1; else echo 0; fi")
if [ "${WIPE_MODULES}" = "1" ]; then
  echo "Wiping node_modules on Pi (--refresh)..."
  ssh "${REMOTE}" "rm -rf ${REMOTE_DIR}/node_modules"
fi
if [ "${FORCE_INSTALL}" = "1" ] || [ "${NEEDS_INSTALL}" = "1" ]; then
  if [ "${NEEDS_INSTALL}" = "1" ]; then
    echo "node_modules missing on Pi — running npm install..."
  else
    echo "Forcing npm install on Pi..."
  fi
  ssh "${REMOTE}" "export NVM_DIR=\$HOME/.nvm; [ -s \$NVM_DIR/nvm.sh ] && . \$NVM_DIR/nvm.sh; cd ${REMOTE_DIR} && npm install --omit=dev --foreground-scripts && npm rebuild --foreground-scripts"
fi

echo "Restarting app via pm2..."
ssh "${REMOTE}" "export NVM_DIR=\$HOME/.nvm; [ -s \$NVM_DIR/nvm.sh ] && . \$NVM_DIR/nvm.sh; pm2 restart radionette 2>/dev/null || pm2 start ${REMOTE_DIR}/dist/index.js --name radionette --cwd ${REMOTE_DIR}; pm2 save"

echo ""
echo "Deploy complete. App restarted."
