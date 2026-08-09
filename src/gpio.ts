import { radioState } from "./state";
import { bandForHardware, channelsForBand } from "./channels";
import { setTunerBand, isTunerActive } from "./tuner";
import { playTunerStatic } from "./static-noise";

// rpio is a native module that only works on the Pi.
// We require() it so the app can still be built on other machines
// (it will fail at runtime if not on a Pi, which is fine).
let rpio: any;
try {
  rpio = require("rpio");
} catch {
  rpio = null;
}

// GPIO pin assignments (BCM numbering)
// Bits 0-7: channel selector, Bit 8: bluetooth, Bit 9: power, Bit 10: stereo (LOW = mono, default)
const CHANNEL_PINS: readonly number[] = [18, 23, 24, 25, 5, 7, 12, 16]; // bits 0-7
const BLUETOOTH_PIN = 20; // bit 8
const POWER_PIN = 21; // bit 9
const MONO_PIN = 19; // bit 10

const ALL_INPUT_PINS = [...CHANNEL_PINS, BLUETOOTH_PIN, POWER_PIN, MONO_PIN];

// Output pins — indicator lights
const POWER_LED_PIN = 17;     // Power indicator light
const BLUETOOTH_LED_PIN = 26; // Bluetooth indicator light
const BACKLIGHT_PIN = 13;     // Display backlight (HIGH = on, LOW = off)
                              // Wire LEDA via MOSFET gate, or LEDK→GND through transistor

const POLL_INTERVAL_MS = 10;
const DEBOUNCE_MS = 50;

let pollTimer: ReturnType<typeof setInterval> | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let prevRawValue = -1;
let stableRawValue = -1;

// When a value is injected via the debug API, we need to suppress the
// poll loop from immediately reverting to the physical pin reading.
// We store the physical value to ignore until the dial actually moves.
let ignorePhysicalValue: number | null = null;

// Tracks the channel id the fallback path last pushed via
// radioState.setChannel(). Used to fire a static burst exactly once
// per real change on the fallback path (tuner path tracks its own).
let fallbackLastChannelId: string | null = null;

function readPins(): number {
  if (!rpio) return 0;

  let value = 0;
  ALL_INPUT_PINS.forEach((pin, index) => {
    const state = rpio.read(pin);
    if (state === rpio.HIGH) {
      value |= 1 << index;
    }
  });
  return value;
}

function processValue(rawValue: number): void {
  // Extract fields
  const channelBits = rawValue & 0xff; // bits 0-7
  const bluetoothBit = (rawValue >> 8) & 1; // bit 8
  const powerBit = (rawValue >> 9) & 1; // bit 9
  // Bit 10 is inverted in software: pin LOW = mono (default — fail-safe if
  // the switch is disconnected, broken, or in the "off" position), pin HIGH
  // = stereo. The pull-down on MONO_PIN guarantees a known LOW when floating.
  const monoBit = ((rawValue >> 10) & 1) ^ 1;

  radioState.setRawGpio(rawValue);

  // Power check first — if off, everything stops
  radioState.setPower(powerBit === 1);
  if (powerBit === 0) {
    updateOutputs(false, false);
    return;
  }

  // Mono only matters when power is on
  radioState.setMono(monoBit === 1);

  // Bluetooth check — if active, radio stops
  radioState.setBluetooth(bluetoothBit === 1);
  if (bluetoothBit === 1) {
    updateOutputs(true, true);
    return;
  }

  // Radio mode — power on, bluetooth off
  updateOutputs(true, false);

  // Top nibble of the channel selector = band selector on the physical
  // rotary. Translate to a band ordinal via channels.json. Unmapped
  // nibbles pass through as band=0 (silence).
  const bandNibble = (channelBits >> 4) & 0x0f;
  const bandOrdinal = bandForHardware(bandNibble) ?? 0;
  setTunerBand(bandOrdinal);

  if (isTunerActive()) {
    // Tuner drives the actual channel selection based on needle angle
    // combined with the band ordinal. gpio.ts stays out of setChannel().
    return;
  }

  // Fallback (no AS5600 / not calibrated / dev mode): pick the first
  // channel in the current band by `order`, or silence if the band is
  // unmapped or empty. Only commit when mode is actually radio —
  // otherwise setChannel() is a no-op and updating our local tracker
  // would strand us thinking we'd committed when we hadn't.
  const channels = channelsForBand(bandOrdinal);
  const pick = channels[0] ?? null;
  const pickId = pick?.id ?? null;
  if (radioState.state.mode === "radio" && pickId !== fallbackLastChannelId) {
    playTunerStatic(pickId);
    fallbackLastChannelId = pickId;
    radioState.setChannel(pick);
  }
}

function updateOutputs(power: boolean, bluetooth: boolean): void {
  if (!rpio) return;
  rpio.write(POWER_LED_PIN, power ? rpio.HIGH : rpio.LOW);
  rpio.write(BLUETOOTH_LED_PIN, bluetooth ? rpio.HIGH : rpio.LOW);
  // Backlight is owned by backlight.ts (driven via PWM, reacting to state
  // events). Do not write BACKLIGHT_PIN here — it would fight the PWM loop.
}

function poll(): void {
  const rawValue = readPins();

  // If we injected a virtual value, ignore poll readings that match
  // the old physical position. Only resume when the dial moves to
  // something new (i.e. the user physically turned the dial).
  if (ignorePhysicalValue !== null) {
    if (rawValue === ignorePhysicalValue) {
      // Dial hasn't moved — keep ignoring
      return;
    }
    // Dial moved to a new position — clear the suppression
    console.log(`[GPIO] Physical dial moved — resuming hardware control`);
    ignorePhysicalValue = null;
  }

  if (rawValue !== prevRawValue) {
    prevRawValue = rawValue;

    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }

    debounceTimer = setTimeout(() => {
      if (rawValue !== stableRawValue) {
        stableRawValue = rawValue;
        const binary = rawValue.toString(2).padStart(11, "0");
        const powerBit = (rawValue >> 9) & 1;
        const bluetoothBit = (rawValue >> 8) & 1;
        let label: string;
        if (powerBit === 0) {
          label = "Power OFF";
        } else if (bluetoothBit === 1) {
          label = "Bluetooth";
        } else {
          const nibble = (rawValue >> 4) & 0x0f;
          const bandOrdinal = bandForHardware(nibble);
          if (bandOrdinal === null) {
            label = `Band: unmapped nibble 0x${nibble.toString(16)}`;
          } else if (isTunerActive()) {
            label = `Band: ${bandOrdinal} (tuner)`;
          } else {
            const first = channelsForBand(bandOrdinal)[0];
            label = first
              ? `Band: ${bandOrdinal} → ${first.name} (fallback: first channel)`
              : `Band: ${bandOrdinal} (empty)`;
          }
        }
        console.log(`[GPIO] Binary: ${binary}  Decimal: ${rawValue}  ${label}`);
        processValue(rawValue);
      }
    }, DEBOUNCE_MS);
  }
}

export function startGpio(): void {
  if (!rpio) {
    console.warn(
      "[GPIO] rpio not available — running without GPIO (dev mode)"
    );
    // In dev mode, set a default state so the web UI has something to show
    radioState.setPower(true);
    radioState.setBluetooth(false);
    return;
  }

  console.log("[GPIO] Initializing pins...");
  rpio.init({ mapping: "gpio" });

  // Set up input pins with pull-down resistors
  ALL_INPUT_PINS.forEach((pin) => {
    rpio.open(pin, rpio.INPUT, rpio.PULL_DOWN);
    console.log(`[GPIO] Pin ${pin} ready (INPUT, PULL_DOWN)`);
  });

  // Set up output pins
  rpio.open(POWER_LED_PIN, rpio.OUTPUT, rpio.LOW);
  console.log(`[GPIO] Pin ${POWER_LED_PIN} ready (OUTPUT, Power LED)`);
  rpio.open(BLUETOOTH_LED_PIN, rpio.OUTPUT, rpio.LOW);
  console.log(`[GPIO] Pin ${BLUETOOTH_LED_PIN} ready (OUTPUT, Bluetooth LED)`);
  rpio.open(BACKLIGHT_PIN, rpio.OUTPUT, rpio.LOW);
  console.log(`[GPIO] Pin ${BACKLIGHT_PIN} ready (OUTPUT, Display Backlight)`);

  console.log("[GPIO] Starting poll loop...");
  pollTimer = setInterval(poll, POLL_INTERVAL_MS);

  // On power-off state.ts clears state.channel to null. Our local
  // fallbackLastChannelId still remembers the previous pick, so on
  // power-on we would think "same channel, no change" and skip
  // setChannel(), leaving the player silent. Reset on power-off.
  radioState.on("power:off", () => {
    fallbackLastChannelId = null;
  });
}

/**
 * Inject a synthetic GPIO value — used by the debug API to simulate
 * dial changes from the web UI. Suppresses the poll loop from reverting
 * to the current physical pin reading until the dial physically moves
 * to a new position.
 */
export function injectGpioValue(rawValue: number): void {
  // Remember what the physical pins are currently reading so we can
  // ignore that value in the poll loop until the dial moves
  const physicalValue = readPins();
  if (physicalValue !== rawValue) {
    ignorePhysicalValue = physicalValue;
  }

  stableRawValue = rawValue;
  prevRawValue = rawValue;

  // Cancel any pending debounce that might fire with the old physical value
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }

  const binary = rawValue.toString(2).padStart(11, "0");
  const nibble = (rawValue >> 4) & 0x0f;
  const bandOrdinal = bandForHardware(nibble);
  const bandLabel =
    bandOrdinal !== null
      ? `band ${bandOrdinal}`
      : `unmapped nibble 0x${nibble.toString(16)}`;
  console.log(
    `[GPIO] Injected: Binary: ${binary}  Decimal: ${rawValue}  ${bandLabel}`
  );
  processValue(rawValue);
}

/**
 * Clear any virtual override and revert to the physical pin state.
 */
export function resetGpioOverride(): void {
  ignorePhysicalValue = null;
  const rawValue = readPins();
  stableRawValue = rawValue;
  prevRawValue = rawValue;

  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }

  const binary = rawValue.toString(2).padStart(11, "0");
  const nibble = (rawValue >> 4) & 0x0f;
  const bandOrdinal = bandForHardware(nibble);
  const bandLabel =
    bandOrdinal !== null
      ? `band ${bandOrdinal}`
      : `unmapped nibble 0x${nibble.toString(16)}`;
  console.log(
    `[GPIO] Reset to physical: Binary: ${binary}  Decimal: ${rawValue}  ${bandLabel}`
  );
  processValue(rawValue);
}

/**
 * Expose the live rpio module + backlight pin so backlight.ts can drive
 * software PWM on it. Returns null if rpio failed to load (dev mode).
 */
export function getBacklightHandle(): { rpio: any; pin: number } | null {
  if (!rpio) return null;
  return { rpio, pin: BACKLIGHT_PIN };
}

export function stopGpio(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }

  if (!rpio) return;

  console.log("[GPIO] Cleaning up pins...");
  rpio.write(POWER_LED_PIN, rpio.LOW);
  rpio.write(BLUETOOTH_LED_PIN, rpio.LOW);
  // BACKLIGHT_PIN is set LOW by stopBacklight() before we get here.
  rpio.write(BACKLIGHT_PIN, rpio.LOW);

  ALL_INPUT_PINS.forEach((pin) => {
    rpio.close(pin);
  });
  rpio.close(POWER_LED_PIN);
  rpio.close(BLUETOOTH_LED_PIN);
  rpio.close(BACKLIGHT_PIN);
  console.log("[GPIO] Cleanup complete.");
}
