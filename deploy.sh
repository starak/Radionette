#!/bin/bash
set -e

REMOTE="pi@radionette.local"
REMOTE_DIR="~/code"

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

echo "Restarting app via pm2..."
ssh "${REMOTE}" "export NVM_DIR=\$HOME/.nvm; [ -s \$NVM_DIR/nvm.sh ] && . \$NVM_DIR/nvm.sh; pm2 restart radionette 2>/dev/null || pm2 start ${REMOTE_DIR}/dist/index.js --name radionette --cwd ${REMOTE_DIR}; pm2 save"

echo ""
echo "Deploy complete. App restarted."
