#!/bin/bash
# wifi-fallback.sh — Start a WiFi hotspot if no network is available at boot.
#
# Installed as a systemd service by setup-pi.sh.
# Uses absolute paths to avoid PATH issues in the systemd environment.

NMCLI="/usr/bin/nmcli"
LOGGER="/usr/bin/logger"
SLEEP="/usr/bin/sleep"

AP_SSID="Radionette-Setup"
AP_PASSWORD="radionette"
AP_CON_NAME="radionette-hotspot"
IFACE="wlan0"

WAIT_SECS=30
CHECK_INTERVAL=5

log() {
  $LOGGER -t "wifi-fallback" "$*"
  echo "[wifi-fallback] $*"
}

is_connected() {
  # Check if wlan0 has a working connection (not the hotspot)
  local state
  state=$($NMCLI -t -f GENERAL.STATE device show "$IFACE" 2>/dev/null | grep -o "connected" | head -1)
  local con
  con=$($NMCLI -t -f GENERAL.CONNECTION device show "$IFACE" 2>/dev/null | cut -d: -f2)

  if [ "$state" = "connected" ] && [ -n "$con" ] && [ "$con" != "$AP_CON_NAME" ] && [ "$con" != "--" ]; then
    return 0
  fi
  return 1
}

start_hotspot() {
  log "Starting fallback hotspot: SSID=$AP_SSID"
  $NMCLI device wifi hotspot \
    ifname "$IFACE" \
    con-name "$AP_CON_NAME" \
    ssid "$AP_SSID" \
    password "$AP_PASSWORD" 2>&1 | while read -r line; do log "$line"; done

  if [ "${PIPESTATUS[0]}" -eq 0 ]; then
    log "Hotspot active"
  else
    log "Failed to start hotspot"
  fi
}

# --- Main ---

log "Waiting up to ${WAIT_SECS}s for WiFi connection..."

elapsed=0
while [ "$elapsed" -lt "$WAIT_SECS" ]; do
  if is_connected; then
    log "WiFi connected — no hotspot needed"
    exit 0
  fi
  $SLEEP "$CHECK_INTERVAL"
  elapsed=$((elapsed + CHECK_INTERVAL))
  log "Still waiting... (${elapsed}s / ${WAIT_SECS}s)"
done

# No connection after waiting — check one more time
if is_connected; then
  log "WiFi connected (last check) — no hotspot needed"
  exit 0
fi

log "No WiFi connection after ${WAIT_SECS}s"
start_hotspot
