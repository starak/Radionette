import { execFile } from "child_process";
import { radioState } from "./state";
import { ADC_MUX_AIN0, isAdcReady, readAdcChannel } from "./adc";

// ── Tuning constants ───────────────────────────────────────────────────

// Polling interval (ms) — read ADC every 100ms
const POLL_INTERVAL_MS = 100;

// Rolling average window size for smoothing noisy pot readings.
// At 100ms poll, 10 samples = 1 second window.
const SMOOTH_WINDOW = 10;

// Only update PulseAudio when smoothed percentage changes by at least this much.
// Prevents constant pactl calls from ADC jitter at percentage boundaries.
const CHANGE_THRESHOLD = 2;

// Only log when raw value changes by this much (reduces log spam from noise)
const LOG_THRESHOLD = 200;

// Minimum interval between log messages (ms) — debounce noisy pot spam
const LOG_DEBOUNCE_MS = 1000;

// Absolute paths — pm2 runs with minimal PATH
const PACTL = "/usr/bin/pactl";

// Mono remap-sink prefix (must match audio.ts)
const MONO_PREFIX = "mono_mix_";

// ── Module state ───────────────────────────────────────────────────────

let pollTimer: ReturnType<typeof setInterval> | null = null;
let devMode = false;

// Rolling average buffer
const rawHistory: number[] = [];

// The last percent value we sent to PulseAudio (to detect actual changes)
let lastAppliedPercent: number | null = null;

// The last raw value we logged (for log-spam reduction)
let lastLoggedRaw: number | null = null;

// Timestamp of the last log message (for debouncing)
let lastLogTime = 0;

// ── Conversion & smoothing ─────────────────────────────────────────────

/**
 * Convert raw ADC value to a percentage (0-100).
 * ADS1115 single-ended range: 0..32767 (positive only).
 * With PGA +/-4.096V and 3V3 across the pot, max raw is ~26400
 * (3.3/4.096 * 32768). Inverted because pot wiring runs high-to-low.
 */
const RAW_MAX = 26400;
function rawToPercent(raw: number): number {
  const clamped = Math.max(0, Math.min(RAW_MAX, raw));
  return 100 - Math.round((clamped / RAW_MAX) * 100);
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
 * Apply volume curve: knob percent → PulseAudio percent.
 *
 * Maps knob 1-100% linearly onto PA 20-100%. The amp's audible threshold
 * sits around PA 15-20%, so any knob position above the click already
 * produces sound. Knob 0% (click stop / power off) still maps to PA 0%.
 */
const PA_FLOOR = 20;
function applyCurve(knobPercent: number): number {
  if (knobPercent <= 0) return 0;
  return Math.round(PA_FLOOR + (knobPercent * (100 - PA_FLOOR)) / 100);
}

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
 * List all real sink names (excludes mono remap-sinks from audio.ts).
 */
async function listAllSinks(): Promise<string[]> {
  const output = await pactl("list", "short", "sinks");
  if (!output) return [];
  return output
    .split("\n")
    .filter((l) => l.trim())
    .map((line) => line.split("\t")[1])
    .filter((name): name is string => !!name && !name.startsWith(MONO_PREFIX));
}

/**
 * Set volume on ALL current PulseAudio sinks.
 * Applies quadratic curve: knob percent is perceptually linear,
 * PulseAudio gets the shaped value.
 */
async function setAllSinksVolume(knobPercent: number): Promise<void> {
  const paPercent = applyCurve(knobPercent);
  const sinks = await listAllSinks();
  const volArg = `${paPercent}%`;
  for (const sink of sinks) {
    await pactl("set-sink-volume", sink, volArg);
  }
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
  const raw = readAdcChannel(ADC_MUX_AIN0);
  if (raw === null) return;

  const now = Date.now();

  // Track raw-value drift for potential debug logging. The actual log line
  // is disabled; we still keep the tracking cheap so it's easy to re-enable.
  if (
    lastLoggedRaw === null ||
    Math.abs(raw - lastLoggedRaw) >= LOG_THRESHOLD
  ) {
    lastLoggedRaw = raw;
    // console.log(`[Volume] ADC raw=${raw} (${rawToPercent(raw)}%)`);
  }

  // Smooth and check if percent actually changed
  const percent = smoothedPercent(raw);

  if (
    lastAppliedPercent === null ||
    Math.abs(percent - lastAppliedPercent) >= CHANGE_THRESHOLD
  ) {
    // Debounce the "Setting volume" log so rapid pot movement doesn't spam.
    if (now - lastLogTime >= LOG_DEBOUNCE_MS) {
      console.log(`[Volume] Setting volume to ${applyCurve(percent)}% (knob ${percent}%)`);
      lastLogTime = now;
    }
    lastAppliedPercent = percent;

    // Update state with the real PA volume (broadcasts to web UI)
    radioState.setVolume(applyCurve(percent));

    // Set PulseAudio volume on all sinks
    setAllSinksVolume(percent).catch((err) =>
      console.warn(`[Volume] Failed to set volume: ${err}`)
    );
  }
}

// ── Public API ─────────────────────────────────────────────────────────

export function initVolume(): void {
  if (!isAdcReady()) {
    devMode = true;
    console.log("[Volume] ADC not available — running in dev mode");
    return;
  }

  // Do an initial read on AIN0 to seed the smoothing buffer
  const initial = readAdcChannel(ADC_MUX_AIN0);
  if (initial === null) {
    console.warn("[Volume] Initial AIN0 read failed — running in dev mode");
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
    `[Volume] Connected — initial reading: raw=${initial} (${percent}%)`
  );

  // Set initial volume in state and PulseAudio
  radioState.setVolume(applyCurve(percent));
  setAllSinksVolume(percent).catch((err) =>
    console.warn(`[Volume] Failed to set initial volume: ${err}`)
  );

  // Listen for mode changes to re-apply volume on new sinks
  radioState.on("mode:bluetooth", onStateChange);
  radioState.on("mode:radio", onStateChange);

  // Start polling
  pollTimer = setInterval(pollADC, POLL_INTERVAL_MS);
  console.log(
    `[Volume] Polling AIN0 every ${POLL_INTERVAL_MS}ms, smoothing window=${SMOOTH_WINDOW}, threshold=${CHANGE_THRESHOLD}%`
  );
}

/**
 * Set volume from software (debug UI). Accepts a PA percentage (0-100).
 * Bypasses the ADC/pot — the next pot movement will override this.
 */
export async function setVolumeSoftware(paPercent: number): Promise<void> {
  const clamped = Math.max(0, Math.min(100, Math.round(paPercent)));
  // Reverse the curve to find a knob% that produces this PA%, then set sinks
  // For simplicity, just set sinks directly at the requested PA% and update state
  radioState.setVolume(clamped);
  const sinks = await listAllSinks();
  const volArg = `${clamped}%`;
  for (const sink of sinks) {
    await pactl("set-sink-volume", sink, volArg);
  }
  console.log(`[Volume] Software override: ${clamped}%`);
}

export function stopVolume(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  radioState.removeListener("mode:bluetooth", onStateChange);
  radioState.removeListener("mode:radio", onStateChange);
  if (!devMode) {
    console.log("[Volume] Stopped");
  }
}
