import { loadChannels } from "./channels";
import { radioState } from "./state";

// Quick-start: try to load rpio, but don't crash if not on Pi
let rpio: any;
try {
  rpio = require("rpio");
} catch {
  rpio = null;
}

const CHANNEL_PINS: readonly number[] = [18, 23, 24, 25, 8, 7, 12, 16]; // bits 0-7
const BLUETOOTH_PIN = 20; // bit 8
const POWER_PIN = 21; // bit 9
const ALL_INPUT_PINS = [...CHANNEL_PINS, BLUETOOTH_PIN, POWER_PIN];

const POLL_INTERVAL_MS = 10;
const DEBOUNCE_MS = 50;

let prevRawValue = -1;
let stableRawValue = -1;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

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

function poll(): void {
  const rawValue = readPins();

  if (rawValue !== prevRawValue) {
    prevRawValue = rawValue;
    if (debounceTimer) clearTimeout(debounceTimer);

    debounceTimer = setTimeout(() => {
      if (rawValue !== stableRawValue) {
        stableRawValue = rawValue;

        const powerBit = (rawValue >> 9) & 1;
        const btBit = (rawValue >> 8) & 1;
        const channelBits = rawValue & 0xff;
        const binary = rawValue.toString(2).padStart(10, "0");

        const timestamp = new Date().toISOString();
        console.log(
          `${timestamp}  raw=${rawValue}  bin=${binary}  power=${powerBit}  bt=${btBit}  channel=${channelBits}`
        );
      }
    }, DEBOUNCE_MS);
  }
}

// --- Main ---
if (!rpio) {
  console.error("rpio not available — this script must run on the Pi.");
  process.exit(1);
}

console.log("=== Radionette GPIO Logger ===");
console.log("Initializing pins...\n");

rpio.init({ mapping: "gpio" });
ALL_INPUT_PINS.forEach((pin) => {
  rpio.open(pin, rpio.INPUT, rpio.PULL_DOWN);
});

console.log(
  "Listening for changes. Flip through all positions and press Ctrl+C when done.\n"
);
console.log(
  "TIMESTAMP                       raw    bin         power  bt  channel"
);
console.log(
  "----------------------------------------------------------------------"
);

const interval = setInterval(poll, POLL_INTERVAL_MS);

function cleanup(): void {
  clearInterval(interval);
  if (debounceTimer) clearTimeout(debounceTimer);
  ALL_INPUT_PINS.forEach((pin) => rpio.close(pin));
  console.log("\nDone.");
  process.exit(0);
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
