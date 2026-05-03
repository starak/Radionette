/**
 * Backlight controller for the GC9A01 panel.
 *
 * The display's LEDA rail is switched by an N-channel MOSFET whose gate is
 * driven by GPIO 13 (see gpio.ts and README.md). This module owns the pin
 * after gpio.ts has opened it.
 *
 * Behaviour:
 *   - Pure on/off — no dimming. (Software PWM was tried first and produced
 *     bad visible flicker; hardware PWM on PWM1/GPIO 13 conflicts with the
 *     analog audio jack, so we just live with two states.)
 *   - On power-on, backlight on, 10-second auto-off timer starts.
 *   - channel:change and BT device connect re-arm the timer (back on for
 *     another 10 s).
 *   - While in Bluetooth search mode (BT mode, no device), backlight stays
 *     on indefinitely — no auto-off.
 *   - power:off cuts the backlight immediately and clears the timer.
 */

import { radioState, RadioState } from "./state";

const OFF_AFTER_MS = 10000; // 10 seconds

let rpio: any = null;
let pin: number = -1;

let offTimer: NodeJS.Timeout | null = null;
let bright = false;          // current pin state cache
let brightLocked = false;    // suppresses auto-off (BT search)
let overrideLocked = false;  // external lock (e.g. debug logo override)

let lastBtSearching = false;
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
  if (brightLocked || overrideLocked) return;
  offTimer = setTimeout(() => {
    offTimer = null;
    writePin(false);
  }, OFF_AFTER_MS);
}

/** Turn backlight on and (re)start the 10s auto-off timer. */
function wake(): void {
  writePin(true);
  scheduleOff();
}

/** Backlight off, all timers cleared. */
function setOff(): void {
  clearOffTimer();
  brightLocked = false;
  // Don't clear overrideLocked — it's owned by the caller (debug page).
  if (overrideLocked) {
    writePin(true);
    return;
  }
  writePin(false);
}

/** Force backlight on with NO auto-off (used while in BT search). */
function lockBright(): void {
  brightLocked = true;
  clearOffTimer();
  writePin(true);
}

function unlockBright(): void {
  brightLocked = false;
}

function onStateChange(s: RadioState): void {
  const inBtSearch = s.power && s.mode === "bluetooth" && !s.bluetoothDevice;
  const btDevice = s.bluetoothDevice;

  if (inBtSearch && !lastBtSearching) {
    lockBright();
  } else if (!inBtSearch && lastBtSearching) {
    unlockBright();
  }

  // BT device connected (null -> non-null) — re-arm the timer.
  if (btDevice && !lastBtDevice) {
    wake();
  }

  lastBtSearching = inBtSearch;
  lastBtDevice = btDevice;
}

function onPowerOn(): void {
  brightLocked = false;
  wake();
}

function onPowerOff(): void {
  setOff();
}

function onChannelChange(): void {
  if (brightLocked) return;
  wake();
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
    writePin(true);
  } else {
    // Released — if power is on, re-arm the auto-off timer from now.
    // Otherwise drop to off.
    if (radioState.state.power) {
      // Don't change the brightness state if BT search has its own lock.
      if (!brightLocked) scheduleOff();
    } else {
      writePin(false);
    }
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
  brightLocked = false;
  overrideLocked = false;
  lastBtSearching = false;
  lastBtDevice = null;

  if (!rpio) {
    console.warn("[Backlight] rpio not available — running in dev mode");
  }

  radioState.on("power:on", onPowerOn);
  radioState.on("power:off", onPowerOff);
  radioState.on("channel:change", onChannelChange);
  radioState.on("state:change", onStateChange);

  // Sync to current state (covers boot-up where radio is already powered).
  if (radioState.state.power) {
    onPowerOn();
  } else {
    setOff();
  }

  console.log(`[Backlight] Started on GPIO ${gpioPin} (auto-off after ${OFF_AFTER_MS}ms)`);
}

export function stopBacklight(): void {
  radioState.off("power:on", onPowerOn);
  radioState.off("power:off", onPowerOff);
  radioState.off("channel:change", onChannelChange);
  radioState.off("state:change", onStateChange);
  clearOffTimer();
  if (rpio && pin >= 0) {
    try { rpio.write(pin, rpio.LOW); } catch { /* ignore */ }
  }
  rpio = null;
  pin = -1;
  console.log("[Backlight] Stopped.");
}
