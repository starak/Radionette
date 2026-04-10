import { openSync, readSync, writeSync, closeSync } from "fs";
import { execFile } from "child_process";
import { radioState } from "./state";

// ── ADS1115 I2C configuration ──────────────────────────────────────────

const I2C_BUS = "/dev/i2c-1";
const ADS1115_ADDR = 0x48;

// ADS1115 registers
const REG_CONVERSION = 0x00;
const REG_CONFIG = 0x01;

// ADS1115 config: continuous conversion, A0 single-ended, PGA +/-4.096V, 128 SPS
// Bit 15:    OS = 1 (start conversion)
// Bits 14-12: MUX = 100 (AIN0 vs GND, single-ended)
// Bits 11-9:  PGA = 001 (FS = +/-4.096V)
// Bit 8:     MODE = 0 (continuous conversion)
// Bits 7-5:  DR = 100 (128 SPS)
// Bits 4-0:  comparator disabled (defaults)
const CONFIG_A0_CONTINUOUS = 0xc283; // 0b1100_0010_1000_0011

// ioctl I2C_SLAVE command
const I2C_SLAVE = 0x0703;

// ── Tuning constants ───────────────────────────────────────────────────

// Polling interval (ms) — read ADC every 100ms
const POLL_INTERVAL_MS = 100;

// Rolling average window size for smoothing noisy pot readings.
// At 100ms poll, 10 samples = 1 second window.
const SMOOTH_WINDOW = 10;

// Only update PulseAudio when smoothed percentage changes by at least this much.
// Prevents constant pactl calls from 1% jitter.
const CHANGE_THRESHOLD = 1;

// Only log when raw value changes by this much (reduces log spam from noise)
const LOG_THRESHOLD = 200;

// Minimum interval between log messages (ms) — debounce noisy pot spam
const LOG_DEBOUNCE_MS = 1000;

// Absolute paths — pm2 runs with minimal PATH
const PACTL = "/usr/bin/pactl";

// ── Module state ───────────────────────────────────────────────────────

let pollTimer: ReturnType<typeof setInterval> | null = null;
let i2cFd: number | null = null;
let devMode = false;

// Rolling average buffer
const rawHistory: number[] = [];

// The last percent value we sent to PulseAudio (to detect actual changes)
let lastAppliedPercent: number | null = null;

// The last raw value we logged (for log-spam reduction)
let lastLoggedRaw: number | null = null;

// Timestamp of the last log message (for debouncing)
let lastLogTime = 0;

// We need ioctl to set the I2C slave address.
// Node doesn't have a built-in ioctl, so we use a small native binding.
let ioctl: ((fd: number, request: number, value: number) => void) | null =
  null;
try {
  ioctl = require("ioctl");
} catch {
  ioctl = null;
}

// ── I2C helpers ────────────────────────────────────────────────────────

/**
 * Open the I2C bus and set the slave address.
 * Returns true if successful.
 */
function openI2C(): boolean {
  try {
    i2cFd = openSync(I2C_BUS, "r+");
    if (!ioctl) {
      throw new Error("ioctl module not available");
    }
    ioctl(i2cFd, I2C_SLAVE, ADS1115_ADDR);
    return true;
  } catch (err: any) {
    console.warn(`[Volume] Cannot open I2C: ${err.message}`);
    if (i2cFd !== null) {
      try {
        closeSync(i2cFd);
      } catch {}
      i2cFd = null;
    }
    return false;
  }
}

/**
 * Configure the ADS1115 for continuous single-ended A0 readings.
 * Must be called once after opening I2C.
 * Returns true if the config was written and verified.
 */
function configureADC(): boolean {
  if (i2cFd === null) return false;

  try {
    // Write config register: register pointer + 2 data bytes
    const configBuf = Buffer.from([
      REG_CONFIG,
      (CONFIG_A0_CONTINUOUS >> 8) & 0xff,
      CONFIG_A0_CONTINUOUS & 0xff,
    ]);
    writeSync(i2cFd, configBuf);

    // Verify config was written correctly
    const regBuf = Buffer.from([REG_CONFIG]);
    writeSync(i2cFd, regBuf);
    const readBuf = Buffer.alloc(2);
    readSync(i2cFd, readBuf, 0, 2, null);
    const readBack = (readBuf[0] << 8) | readBuf[1];

    // OS bit (15) clears after conversion starts, so mask it for comparison
    const expected = CONFIG_A0_CONTINUOUS & 0x7fff;
    const actual = readBack & 0x7fff;
    if (actual !== expected) {
      console.warn(
        `[Volume] Config verify failed: wrote 0x${expected.toString(16)}, read 0x${actual.toString(16)}`
      );
      return false;
    }

    // Point back to conversion register for fast reads
    const convBuf = Buffer.from([REG_CONVERSION]);
    writeSync(i2cFd, convBuf);

    return true;
  } catch (err: any) {
    console.error(`[Volume] Config write failed: ${err.message}`);
    return false;
  }
}

/**
 * Read the current conversion value from the ADS1115.
 *
 * After configureADC(), the chip runs continuous conversions on A0
 * (single-ended vs GND) at 128 SPS. We just read the conversion register.
 *
 * Returns the raw 16-bit signed value, or null on error.
 */
function readADC(): number | null {
  if (i2cFd === null) return null;

  try {
    // The register pointer is already set to REG_CONVERSION from init,
    // so we can just read 2 bytes directly
    const readBuf = Buffer.alloc(2);
    readSync(i2cFd, readBuf, 0, 2, null);

    const raw = (readBuf[0] << 8) | readBuf[1];
    return raw;
  } catch (err: any) {
    console.error(`[Volume] ADC read error: ${err.message}`);
    return null;
  }
}

// ── Conversion & smoothing ─────────────────────────────────────────────

/**
 * Convert raw ADC value to a percentage (0-100).
 * ADS1115 single-ended range: 0..32767 (positive only).
 * With PGA +/-4.096V and this pot, max raw is ~14300.
 * Inverted because pot wiring runs high-to-low.
 */
function rawToPercent(raw: number): number {
  const clamped = Math.max(0, Math.min(14300, raw));
  return 100 - Math.round((clamped / 14300) * 100);
}

/**
 * Add a raw reading to the rolling average buffer and return the
 * smoothed percentage.
 */
function smoothedPercent(raw: number): number {
  rawHistory.push(raw);
  if (rawHistory.length > SMOOTH_WINDOW) {
    rawHistory.shift();
  }

  // Simple arithmetic mean
  const sum = rawHistory.reduce((a, b) => a + b, 0);
  const avg = sum / rawHistory.length;
  return rawToPercent(avg);
}

// ── PulseAudio volume control ──────────────────────────────────────────

/**
 * Run a pactl command. Returns stdout on success, null on error.
 */
function pactl(...args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(PACTL, args, (err, stdout, stderr) => {
      if (err) {
        console.warn(`[Volume] pactl ${args.join(" ")} failed: ${stderr || err.message}`);
        resolve(null);
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

/**
 * List all sink names (short format).
 */
async function listAllSinks(): Promise<string[]> {
  const output = await pactl("list", "short", "sinks");
  if (!output) return [];
  return output
    .split("\n")
    .filter((l) => l.trim())
    .map((line) => line.split("\t")[1])
    .filter((name): name is string => !!name);
}

/**
 * Set volume on ALL current PulseAudio sinks.
 * Linear curve: percentage maps directly to PulseAudio percent.
 */
async function setAllSinksVolume(percent: number): Promise<void> {
  const sinks = await listAllSinks();
  const volArg = `${percent}%`;
  for (const sink of sinks) {
    await pactl("set-sink-volume", sink, volArg);
  }
}

/**
 * Apply volume to a single sink by name.
 * Used when a new sink appears (e.g. Bluetooth connects).
 */
async function setSinkVolume(sinkName: string, percent: number): Promise<void> {
  await pactl("set-sink-volume", sinkName, `${percent}%`);
}

// ── Sink event watcher ─────────────────────────────────────────────────
// audio.ts already runs `pactl subscribe` for mono/stereo purposes.
// Rather than a second subscribe process, we listen on the radioState
// for events that indicate new sinks (Bluetooth connect). We also
// periodically re-apply volume to catch sinks that appeared between polls.
//
// However, the simplest reliable approach: every time we set volume, we
// set it on ALL sinks. Since we only call setAllSinksVolume when the
// smoothed percent *changes*, this is infrequent (not every 100ms).
// New sinks that appear between volume changes will get caught on the
// next pot movement.
//
// For the edge case where BT connects and the user doesn't touch the pot,
// we listen for state:change events that indicate bluetooth mode changes
// and re-apply the current volume.

function onStateChange(): void {
  // Re-apply current volume when mode changes (covers BT connect/disconnect)
  if (lastAppliedPercent !== null && !devMode) {
    setAllSinksVolume(lastAppliedPercent).catch((err) =>
      console.warn(`[Volume] Failed to re-apply volume on state change: ${err}`)
    );
  }
}

// ── Poll loop ──────────────────────────────────────────────────────────

/**
 * Poll the ADC, smooth the reading, and update volume if changed.
 */
function pollADC(): void {
  const raw = readADC();
  if (raw === null) return;

  const now = Date.now();

  // Log raw changes (for debugging noisy pot), debounced to max 1/sec
  if (
    (lastLoggedRaw === null ||
      Math.abs(raw - lastLoggedRaw) >= LOG_THRESHOLD) &&
    now - lastLogTime >= LOG_DEBOUNCE_MS
  ) {
    const instantPercent = rawToPercent(raw);
    //console.log(`[Volume] ADC raw=${raw} (${instantPercent}%)`);
    lastLoggedRaw = raw;
    lastLogTime = now;
  }

  // Smooth and check if percent actually changed
  const percent = smoothedPercent(raw);

  if (
    lastAppliedPercent === null ||
    Math.abs(percent - lastAppliedPercent) >= CHANGE_THRESHOLD
  ) {
    // Debounce the "Setting volume" log too
    if (now - lastLogTime >= LOG_DEBOUNCE_MS) {
      console.log(`[Volume] Setting volume to ${percent}%`);
      lastLogTime = now;
    }
    lastAppliedPercent = percent;

    // Update state (broadcasts to web UI via state:change)
    radioState.setVolume(percent);

    // Set PulseAudio volume on all sinks
    setAllSinksVolume(percent).catch((err) =>
      console.warn(`[Volume] Failed to set volume: ${err}`)
    );
  }
}

// ── Public API ─────────────────────────────────────────────────────────

export function initVolume(): void {
  if (!ioctl) {
    devMode = true;
    console.log("[Volume] Dev mode — ioctl not available, skipping I2C ADC");
    return;
  }

  if (!openI2C()) {
    devMode = true;
    console.log("[Volume] Dev mode — I2C not available");
    return;
  }

  // Configure for single-ended A0 continuous conversion
  if (!configureADC()) {
    console.warn("[Volume] ADS1115 not responding on I2C bus 1 at 0x48");
    devMode = true;
    return;
  }

  // Do an initial read to verify and seed the smoothing buffer
  const initial = readADC();
  if (initial === null) {
    console.warn("[Volume] ADS1115 configured but first read failed");
    devMode = true;
    return;
  }

  // Seed the smoothing buffer with initial reading so we don't ramp from 0
  for (let i = 0; i < SMOOTH_WINDOW; i++) {
    rawHistory.push(initial);
  }

  const percent = rawToPercent(initial);
  lastAppliedPercent = percent;

  console.log(
    `[Volume] ADS1115 connected — initial reading: raw=${initial} (${percent}%)`
  );

  // Set initial volume in state and PulseAudio
  radioState.setVolume(percent);
  setAllSinksVolume(percent).catch((err) =>
    console.warn(`[Volume] Failed to set initial volume: ${err}`)
  );

  // Listen for mode changes to re-apply volume on new sinks
  radioState.on("mode:bluetooth", onStateChange);
  radioState.on("mode:radio", onStateChange);

  // Start polling
  pollTimer = setInterval(pollADC, POLL_INTERVAL_MS);
  console.log(
    `[Volume] Polling ADC every ${POLL_INTERVAL_MS}ms, smoothing window=${SMOOTH_WINDOW}, threshold=${CHANGE_THRESHOLD}%`
  );
}

export function stopVolume(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (i2cFd !== null) {
    try {
      closeSync(i2cFd);
    } catch {}
    i2cFd = null;
  }
  radioState.removeListener("mode:bluetooth", onStateChange);
  radioState.removeListener("mode:radio", onStateChange);
  if (!devMode) {
    console.log("[Volume] Stopped");
  }
}
