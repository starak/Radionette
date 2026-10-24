import { execFile } from "child_process";
import { radioState } from "./state";
import { ADC_MUX_AIN0, isAdcReady, readAdcChannel } from "./adc";
import {
  onSpotifyVolumeChanged,
  setSpotifyVolume,
  SPOTIFY_BAND_ORDINAL,
} from "./spotify-connect";

// ── Tuning constants ───────────────────────────────────────────────────

// Polling interval (ms) — read ADC every 100ms
const POLL_INTERVAL_MS = 100;

// Rolling average window size for smoothing noisy pot readings.
// At 100ms poll, 15 samples = 1.5 seconds. A trimmed mean below discards the
// three highest and lowest samples, rejecting pot/ADC spikes without making
// deliberate turns excessively sluggish.
const SMOOTH_WINDOW = 15;

// Only update PulseAudio when smoothed percentage changes by at least this much.
// Prevents constant pactl calls from ADC jitter at percentage boundaries.
const CHANGE_THRESHOLD = 3;
const FAST_CHANGE_THRESHOLD = 6;
const STABLE_CHANGE_MS = 300;
const PICKUP_TOLERANCE = 2;

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
let lastObservedPercent: number | null = null;
let candidatePercent: number | null = null;
let candidateSince = 0;
let spotifyTakeoverTarget: number | null = null;
let previousPickupVolume: number | null = null;
let pendingSpotifyEcho: { volume: number; expiresAt: number } | null = null;
let unsubscribeSpotifyVolume: (() => void) | null = null;
let spotifySessionInitialized = false;

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

  const sorted = [...rawHistory].sort((a, b) => a - b);
  const trim = sorted.length >= 9 ? Math.min(3, Math.floor((sorted.length - 1) / 4)) : 0;
  const kept = trim ? sorted.slice(trim, -trim) : sorted;
  const sum = kept.reduce((a, b) => a + b, 0);
  const avg = sum / kept.length;
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

async function setAllSinksPaVolume(paPercent: number): Promise<void> {
  const sinks = await listAllSinks();
  const volArg = `${Math.max(0, Math.min(100, Math.round(paPercent)))}%`;
  for (const sink of sinks) await pactl("set-sink-volume", sink, volArg);
}

function spotifyBandActive(): boolean {
  const state = radioState.state;
  return state.power && state.mode === "radio" && state.selectedBand === SPOTIFY_BAND_ORDINAL;
}

function applyPhysicalVolume(percent: number, now = Date.now(), force = false): void {
  const paPercent = applyCurve(percent);
  if (!force && lastAppliedPercent !== null && Math.abs(percent - lastAppliedPercent) < CHANGE_THRESHOLD) return;
  lastAppliedPercent = percent;
  candidatePercent = null;

  if (now - lastLogTime >= LOG_DEBOUNCE_MS) {
    console.log(`[Volume] Setting volume to ${paPercent}% (knob ${percent}%)`);
    lastLogTime = now;
  }

  if (spotifyBandActive()) {
    pendingSpotifyEcho = { volume: paPercent, expiresAt: now + 3000 };
    if (setSpotifyVolume(paPercent)) {
      // In Spotify mode Soloist is the sole attenuator. Keeping the hardware
      // sink at unity avoids multiplying two independent percentage curves.
      setAllSinksPaVolume(100).catch((err) =>
        console.warn(`[Volume] Failed to set Spotify hardware unity: ${err}`),
      );
      spotifySessionInitialized = true;
    }
  } else {
    setAllSinksVolume(percent).catch((err) =>
      console.warn(`[Volume] Failed to set volume: ${err}`),
    );
  }
  radioState.setVolume(paPercent, "knob");
}

function onSpotifyVolume(volume: number): void {
  if (!spotifyBandActive()) return;
  const now = Date.now();

  // Soloist may restore a stale/high session volume. Before exposing the
  // hardware sink at unity, seed Soloist from the physical knob so startup
  // can never produce a full-volume burst.
  if (!spotifySessionInitialized && lastObservedPercent !== null) {
    const safeVolume = applyCurve(lastObservedPercent);
    pendingSpotifyEcho = { volume: safeVolume, expiresAt: now + 3000 };
    if (setSpotifyVolume(safeVolume)) {
      spotifySessionInitialized = true;
      setAllSinksPaVolume(100).catch((err) =>
        console.warn(`[Volume] Failed to set Spotify hardware unity: ${err}`),
      );
      radioState.setVolume(safeVolume, "knob");
      console.log(`[Volume] Seeded Spotify from physical knob at ${safeVolume}%`);
    }
    return;
  }

  if (
    pendingSpotifyEcho &&
    now <= pendingSpotifyEcho.expiresAt &&
    Math.abs(volume - pendingSpotifyEcho.volume) <= 1
  ) {
    pendingSpotifyEcho = null;
    return;
  }

  pendingSpotifyEcho = null;
  spotifyTakeoverTarget = volume;
  previousPickupVolume = lastObservedPercent === null ? null : applyCurve(lastObservedPercent);
  candidatePercent = null;
  radioState.setVolume(volume, "spotify");
  console.log(`[Volume] Spotify took control at ${volume}%; move knob to that level to pick up`);
}

function onBandChange(band: number): void {
  pendingSpotifyEcho = null;
  if (band === SPOTIFY_BAND_ORDINAL) {
    spotifySessionInitialized = false;
    return;
  }
  spotifySessionInitialized = false;
  spotifyTakeoverTarget = null;
  previousPickupVolume = null;
  if (lastObservedPercent !== null && !devMode) {
    applyPhysicalVolume(lastObservedPercent, Date.now(), true);
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
  lastObservedPercent = percent;

  if (spotifyTakeoverTarget !== null && spotifyBandActive()) {
    const knobVolume = applyCurve(percent);
    const previous = previousPickupVolume;
    const closeEnough = Math.abs(knobVolume - spotifyTakeoverTarget) <= PICKUP_TOLERANCE;
    const crossed =
      previous !== null &&
      (previous - spotifyTakeoverTarget) * (knobVolume - spotifyTakeoverTarget) <= 0;
    previousPickupVolume = knobVolume;
    if (!closeEnough && !crossed) return;

    console.log(`[Volume] Physical knob picked up at ${knobVolume}%`);
    spotifyTakeoverTarget = null;
    applyPhysicalVolume(percent, now, true);
    return;
  }

  const delta = lastAppliedPercent === null ? Infinity : Math.abs(percent - lastAppliedPercent);
  if (delta < CHANGE_THRESHOLD) {
    candidatePercent = null;
    return;
  }
  if (delta >= FAST_CHANGE_THRESHOLD) {
    applyPhysicalVolume(percent, now);
    return;
  }
  if (candidatePercent === null || Math.abs(percent - candidatePercent) > 1) {
    candidatePercent = percent;
    candidateSince = now;
    return;
  }
  if (now - candidateSince >= STABLE_CHANGE_MS) applyPhysicalVolume(percent, now);
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
  lastObservedPercent = percent;

  console.log(
    `[Volume] Connected — initial reading: raw=${initial} (${percent}%)`
  );

  // Set initial volume in state and PulseAudio
  radioState.setVolume(applyCurve(percent), "knob");
  setAllSinksVolume(percent).catch((err) =>
    console.warn(`[Volume] Failed to set initial volume: ${err}`)
  );

  // Listen for mode changes to re-apply volume on new sinks
  radioState.on("mode:bluetooth", onStateChange);
  radioState.on("mode:radio", onStateChange);
  radioState.on("band:change", onBandChange);
  unsubscribeSpotifyVolume = onSpotifyVolumeChanged(onSpotifyVolume);

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
  radioState.setVolume(clamped, "software");
  const sinks = await listAllSinks();
  const volArg = `${clamped}%`;
  for (const sink of sinks) {
    await pactl("set-sink-volume", sink, volArg);
  }
  console.log(`[Volume] Software override: ${clamped}%`);
}

/** Immediately discard a software debug override and apply the pot position. */
export async function resetVolumeToPhysical(): Promise<void> {
  if (devMode) return;
  const raw = readAdcChannel(ADC_MUX_AIN0);
  if (raw === null) throw new Error("Could not read the physical volume potentiometer");
  rawHistory.length = 0;
  for (let i = 0; i < SMOOTH_WINDOW; i++) rawHistory.push(raw);
  const percent = rawToPercent(raw);
  lastAppliedPercent = percent;
  lastObservedPercent = percent;
  spotifyTakeoverTarget = null;
  radioState.setVolume(applyCurve(percent), "knob");
  await setAllSinksVolume(percent);
  console.log(`[Volume] Reset to physical pot: raw=${raw} (${percent}%)`);
}

export function stopVolume(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  radioState.removeListener("mode:bluetooth", onStateChange);
  radioState.removeListener("mode:radio", onStateChange);
  radioState.removeListener("band:change", onBandChange);
  unsubscribeSpotifyVolume?.();
  unsubscribeSpotifyVolume = null;
  if (!devMode) {
    console.log("[Volume] Stopped");
  }
}
