/**
 * Backlight controller for the GC9A01 panel.
 *
 * GPIO 13 drives the display backlight directly (LEDA on the existing bare
 * panel, or BLK on the optional 8-pin PCB module). This module owns the pin
 * after gpio.ts has opened it. HIGH = on, LOW = off.
 *
 * Behaviour:
 *   - Pure on/off — no dimming. (Software PWM was tried first and produced
 *     bad visible flicker; hardware PWM on PWM1/GPIO 13 conflicts with the
 *     analog audio jack, so we just live with two states.)
 *   - On power-on, backlight on, 20-second auto-off timer starts.
 *   - Anything that changes the panel image (channel change, BT device
 *     connect, now-playing album art appearing) re-arms the timer so the
 *     user gets a fresh 20-second window to see the update.
 *   - Lower GPIO bits select auto-off, always-on, or display-off policy.
 *     The selected policy applies in radio and Bluetooth modes.
 *   - power:off cuts the backlight immediately and clears the timer.
 */

import { radioState, RadioState } from "./state";
import {
  BacklightPolicy,
  DisplaySetting,
  displayModeAllowsArtwork,
  resolveDisplaySetting,
} from "./display-settings";

const OFF_AFTER_MS = 20000;

let rpio: any = null;
let pin: number = -1;

let offTimer: NodeJS.Timeout | null = null;
let bright = false;          // current pin state cache
let overrideLocked = false;  // external lock (e.g. debug logo override)
let selectedPolicy: BacklightPolicy = "auto";

let lastBtDevice: string | null = null;

function clearOffTimer(): void {
  if (offTimer) {
    clearTimeout(offTimer);
    offTimer = null;
  }
}

function writePin(on: boolean): void {
  bright = on;
  if (!rpio || pin < 0) return;
  rpio.write(pin, on ? rpio.HIGH : rpio.LOW);
}

function scheduleOff(): void {
  clearOffTimer();
  if (selectedPolicy !== "auto" || overrideLocked) return;
  offTimer = setTimeout(() => {
    offTimer = null;
    writePin(false);
  }, OFF_AFTER_MS);
}

/** Turn backlight on and (re)start the 20s auto-off timer. */
function wake(): void {
  if (!radioState.state.power) return;
  if (overrideLocked || selectedPolicy === "always-on") {
    clearOffTimer();
    writePin(true);
    return;
  }
  if (selectedPolicy === "off") {
    clearOffTimer();
    writePin(false);
    return;
  }
  writePin(true);
  scheduleOff();
}

function applyPolicy(): void {
  clearOffTimer();
  if (!radioState.state.power) {
    writePin(false);
  } else if (overrideLocked || selectedPolicy === "always-on") {
    writePin(true);
  } else if (selectedPolicy === "off") {
    writePin(false);
  } else {
    wake();
  }
}

function onStateChange(s: RadioState): void {
  const btDevice = s.bluetoothDevice;

  // BT device connected (null -> non-null) — re-arm the timer.
  if (btDevice && !lastBtDevice) {
    wake();
  }

  lastBtDevice = btDevice;
}

function onPowerOn(): void {
  applyPolicy();
}

function onPowerOff(): void {
  clearOffTimer();
  writePin(false);
}

function onChannelChange(): void {
  if (!radioState.state.power) return;
  wake();
}

function onModeChange(): void {
  if (!radioState.state.power) return;
  wake();
}

/**
 * Album art appearing (or disappearing back to the channel logo) is a
 * visible panel change, so wake the backlight the same way a channel
 * change would.
 */
function onArtworkChange(): void {
  if (!radioState.state.power) return;
  if (!displayModeAllowsArtwork(radioState.state.displayMode)) return;
  wake();
}

function onDisplayMode(setting: DisplaySetting): void {
  selectedPolicy = setting.backlight;
  applyPolicy();
}

/**
 * External lock — keeps the backlight on indefinitely until released.
 * Used by the debug page logo-override so the test grid is always visible.
 * Independent of brightLocked (BT search) so neither overrides the other.
 */
export function setBacklightOverrideLock(locked: boolean): void {
  overrideLocked = locked;
  if (locked) {
    clearOffTimer();
    writePin(radioState.state.power);
  } else {
    applyPolicy();
  }
}

/**
 * Initialise the backlight controller. The pin must already be opened as
 * OUTPUT/LOW by gpio.ts before calling this. We do not open or close the
 * pin ourselves — gpio.ts owns its lifecycle.
 */
export function startBacklight(rpioModule: any, gpioPin: number): void {
  rpio = rpioModule;
  pin = gpioPin;
  bright = false;
  overrideLocked = false;
  lastBtDevice = null;
  selectedPolicy = resolveDisplaySetting(radioState.state.displayBits).backlight;

  if (!rpio) {
    console.warn("[Backlight] rpio not available — running in dev mode");
  }

  radioState.on("power:on", onPowerOn);
  radioState.on("power:off", onPowerOff);
  radioState.on("channel:change", onChannelChange);
  radioState.on("artwork:change", onArtworkChange);
  radioState.on("display:mode", onDisplayMode);
  radioState.on("mode:bluetooth", onModeChange);
  radioState.on("mode:radio", onModeChange);
  radioState.on("state:change", onStateChange);

  // Sync to current state (covers boot-up where radio is already powered).
  if (radioState.state.power) {
    onPowerOn();
  } else {
    onPowerOff();
  }

  console.log(`[Backlight] Started on GPIO ${gpioPin} (auto-off after ${OFF_AFTER_MS}ms)`);
}

export function stopBacklight(): void {
  radioState.off("power:on", onPowerOn);
  radioState.off("power:off", onPowerOff);
  radioState.off("channel:change", onChannelChange);
  radioState.off("artwork:change", onArtworkChange);
  radioState.off("display:mode", onDisplayMode);
  radioState.off("mode:bluetooth", onModeChange);
  radioState.off("mode:radio", onModeChange);
  radioState.off("state:change", onStateChange);
  clearOffTimer();
  if (rpio && pin >= 0) {
    try { rpio.write(pin, rpio.LOW); } catch { /* ignore */ }
  }
  rpio = null;
  pin = -1;
  console.log("[Backlight] Stopped.");
}
