#!/bin/bash
set -e

REMOTE="radionette"
REMOTE_DIR="~/code"

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

echo "Installing dependencies on Pi..."
ssh "${REMOTE}" "cd ${REMOTE_DIR} && PATH=~/.nvm/versions/node/v24.14.1/bin:\$PATH npm install --omit=dev"

echo "Restarting app via pm2..."
ssh "${REMOTE}" "sudo env PATH=/home/pi/.nvm/versions/node/v24.14.1/bin:\$PATH pm2 restart radionette"

echo ""
echo "Deploy complete. App restarted."
