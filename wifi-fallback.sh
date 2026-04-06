#!/bin/bash
# wifi-fallback.sh — Start a WiFi hotspot if no network is available at boot.
#
# Installed as a systemd service by setup-pi.sh.
# Uses absolute paths to avoid PATH issues in the systemd environment.

NMCLI="/usr/bin/nmcli"
LOGGER="/usr/bin/logger"
SLEEP="/usr/bin/sleep"

AP_SSID="Radionette-Setup"
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
  log "Starting fallback hotspot: SSID=$AP_SSID (open)"

  # Delete any stale hotspot profile
  $NMCLI connection delete "$AP_CON_NAME" 2>/dev/null

  # Create an open AP profile — WPA-PSK fails on Pi 3 BCM43430 firmware
  $NMCLI connection add \
    type wifi \
    con-name "$AP_CON_NAME" \
    ifname "$IFACE" \
    ssid "$AP_SSID" \
    autoconnect no \
    wifi.mode ap \
    wifi.band bg \
    wifi.channel 6 \
    ipv4.method shared \
    ipv4.addresses 10.42.0.1/24 2>&1 | while read -r line; do log "$line"; done

  # Activate it
  $NMCLI connection up "$AP_CON_NAME" 2>&1 | while read -r line; do log "$line"; done

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
