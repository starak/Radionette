/**
 * AS5600 magnetic angle sensor → I2C tuner.
 *
 * The AS5600 sits on the needle shaft (single 180° sweep, no multi-turn
 * ambiguity) and is read directly over I2C bus 1 at address 0x36. We
 * share the ADS1115's file descriptor via the helpers in adc.ts.
 *
 * Responsibilities:
 *  - Poll RAW_ANGLE at TUNER_POLL_MS.
 *  - Persist / restore the two-point calibration (raw min ↔ raw max
 *    corresponding to the mechanical stops of the needle) in 12-bit
 *    angle counts (0..4095).
 *  - Convert raw → smoothed fraction in [0,1] across the calibrated
 *    span, handling wrap-around when the sweep straddles the 0/4095
 *    boundary.
 *  - Combine fraction + current band nibble (from gpio.ts) to pick a
 *    concrete channel from channels.json and call radioState.setChannel.
 *  - Monitor STATUS + AGC and log magnet-health transitions.
 *
 * Calibration file lives at ~/.radionette/tuner-calibration.json and is
 * only rewritten when the user hits the calibrate endpoints (no periodic
 * writes needed — the sensor is absolute per revolution).
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { isAdcReady, i2cProbe, i2cReadReg } from "./adc";
import { channelsForBand } from "./channels";
import { radioState, ChannelInfo } from "./state";

// ── AS5600 register map ────────────────────────────────────────────────

const AS5600_ADDR = 0x36;

const AS5600_REG_STATUS = 0x0b;
const AS5600_REG_RAW_ANGLE = 0x0c;
const AS5600_REG_AGC = 0x1a;
const AS5600_REG_MAGNITUDE = 0x1b;

const AS5600_STATUS_MD = 1 << 5; // magnet detected
const AS5600_STATUS_ML = 1 << 4; // magnet too weak
const AS5600_STATUS_MH = 1 << 3; // magnet too strong

// ── Tuning constants ───────────────────────────────────────────────────

const TUNER_POLL_MS = 50;

// Smoothing window for the raw angle reading. 6 samples * 50 ms = 300 ms
// low-pass — invisible to the eye, kills any tiny sensor jitter.
const SMOOTH_WINDOW = 6;

// Fractional deadband before we consider the position "changed enough"
// to reconsider which wedge the needle is in. 0.008 == 0.8% of full sweep.
const FRACTION_HYSTERESIS = 0.008;

// Additional wedge-boundary hysteresis: once committed to a channel,
// require the fraction to be at least this much *inside* a different
// wedge before we switch. Fraction of the wedge width.
const WEDGE_ENTRY_HYSTERESIS = 0.20;

// Magnet-health check every N polls (poll is 50 ms; every 20 = 1 s).
const HEALTH_CHECK_INTERVAL = 20;

// Default calibration if no file exists yet. In 12-bit angle counts
// (0..4095). Assumes the sweep straddles the wrap at 0/4095, which is
// what the earlier monitor session showed (1955 → 4067). The debug UI
// provides Set Min / Set Max buttons.
const DEFAULT_MIN_ANGLE = 1955;
const DEFAULT_MAX_ANGLE = 4067;

const CALIB_FILE = path.join(
  os.homedir(),
  ".radionette",
  "tuner-calibration.json"
);

// ── State ──────────────────────────────────────────────────────────────

interface Calibration {
  /** 12-bit angle count at the "0%" mechanical stop (CCW end by default) */
  minAngle: number;
  /** 12-bit angle count at the "100%" mechanical stop (CW end by default) */
  maxAngle: number;
  /**
   * If true, the fraction is inverted (1 - f) before use. Handy when
   * the AS5600 DIR pin ended up producing the opposite polarity of
   * what feels natural for the physical needle.
   */
  invert: boolean;
}

let calib: Calibration = {
  minAngle: DEFAULT_MIN_ANGLE,
  maxAngle: DEFAULT_MAX_ANGLE,
  invert: false,
};

let pollTimer: ReturnType<typeof setInterval> | null = null;
let devMode = false;
let sensorPresent = false;
let pollTick = 0;

const rawHistory: number[] = [];

let lastAppliedChannelNumber: number | null = null;
let lastCommittedFraction: number | null = null;

// Current band nibble, updated by gpio.ts via setTunerBand().
let currentBand = 0;

// Magnet-health hysteresis — only log transitions, not every poll.
let lastMagnetLabel: string | null = null;

// ── Helpers ────────────────────────────────────────────────────────────

function ensureCalibDir(): void {
  const dir = path.dirname(CALIB_FILE);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // ignore
  }
}

function loadCalibration(): void {
  try {
    const raw = fs.readFileSync(CALIB_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Partial<Calibration> & {
      // Backwards compat with older ADC-based calibration
      minRaw?: number;
      maxRaw?: number;
    };
    // Prefer new field names; fall back to legacy names if present
    const minAngle =
      typeof parsed.minAngle === "number" ? parsed.minAngle : parsed.minRaw;
    const maxAngle =
      typeof parsed.maxAngle === "number" ? parsed.maxAngle : parsed.maxRaw;
    if (
      typeof minAngle === "number" &&
      typeof maxAngle === "number" &&
      minAngle !== maxAngle &&
      minAngle >= 0 &&
      maxAngle >= 0
    ) {
      calib = {
        minAngle,
        maxAngle,
        invert: !!parsed.invert,
      };
      console.log(
        `[Tuner] Loaded calibration: minAngle=${calib.minAngle} maxAngle=${calib.maxAngle} invert=${calib.invert}`
      );
      return;
    }
    console.log(`[Tuner] Calibration file present but invalid — using defaults`);
  } catch (err: any) {
    if (err.code !== "ENOENT") {
      console.log(`[Tuner] Could not read calibration file: ${err.message}`);
    }
    console.log(
      `[Tuner] Using default calibration (minAngle=${calib.minAngle} maxAngle=${calib.maxAngle}). Calibrate via the debug UI.`
    );
  }
}

function saveCalibration(): void {
  ensureCalibDir();
  try {
    fs.writeFileSync(CALIB_FILE, JSON.stringify(calib, null, 2), "utf-8");
    console.log(
      `[Tuner] Saved calibration: minAngle=${calib.minAngle} maxAngle=${calib.maxAngle} invert=${calib.invert}`
    );
  } catch (err: any) {
    console.error(`[Tuner] Failed to write calibration file: ${err.message}`);
  }
}

/**
 * Read the AS5600's 12-bit RAW_ANGLE register. Returns null on failure
 * or when the sensor isn't on the bus.
 */
function readAngle(): number | null {
  if (!sensorPresent) return null;
  const buf = i2cReadReg(AS5600_ADDR, AS5600_REG_RAW_ANGLE, 2);
  if (!buf) return null;
  return ((buf[0] << 8) | buf[1]) & 0x0fff;
}

/**
 * Compute a smoothed angle in the RAW_ANGLE space (0..4095). Handles
 * the wrap point by unwrapping raw readings that straddle 0/4095
 * before averaging — otherwise a shaft sitting at 4090 would produce
 * a smoothed mean of ~2000 when the buffer briefly saw 10.
 */
function smoothAngle(raw: number): number {
  rawHistory.push(raw);
  if (rawHistory.length > SMOOTH_WINDOW) rawHistory.shift();
  if (rawHistory.length === 1) return raw;

  // Unwrap relative to the first sample. Anything more than 2048 apart
  // is treated as "on the other side of the wrap point" and shifted.
  const ref = rawHistory[0];
  let sum = 0;
  for (const v of rawHistory) {
    let d = v - ref;
    if (d > 2048) d -= 4096;
    else if (d < -2048) d += 4096;
    sum += ref + d;
  }
  const avg = sum / rawHistory.length;
  // Re-wrap into [0, 4095]
  return ((avg % 4096) + 4096) % 4096;
}

/**
 * Convert a smoothed 12-bit angle (0..4095) into a fraction in [0,1]
 * across the calibrated sweep. Correctly handles the case where the
 * sweep straddles the 0/4095 wrap point (calibration min > max in
 * angle terms).
 */
function angleToFraction(angle: number): number {
  const { minAngle, maxAngle, invert } = calib;

  // Signed angular distance from minAngle around the short arc.
  const arcTo = (target: number): number => {
    let d = target - minAngle;
    if (d < 0) d += 4096;
    return d;
  };

  const total = arcTo(maxAngle);
  if (total === 0) return 0;

  let t = arcTo(angle) / total;
  // If the angle is outside the calibrated arc, clamp to whichever end
  // it's closer to. Anything past maxAngle in the forward direction
  // stays at 1; anything behind minAngle stays at 0.
  if (t > 1) {
    // Check whether we're on the "wrap around the other side" region
    // — if so, decide 0 or 1 based on which end is closer.
    const distToMin = 4096 - arcTo(angle); // distance going backwards
    const distToMax = arcTo(angle) - total; // distance going forwards
    t = distToMax < distToMin ? 1 : 0;
  }
  if (t < 0) t = 0;
  return invert ? 1 - t : t;
}

/**
 * Given a fractional needle position in [0,1] and the list of channels
 * available in the current band (sorted by channel number), return the
 * channel whose wedge contains the needle.
 */
function pickChannelFromFraction(
  fraction: number,
  channels: ChannelInfo[]
): ChannelInfo | null {
  if (channels.length === 0) return null;
  if (channels.length === 1) return channels[0];

  const wedgeWidth = 1 / channels.length;
  let idx = Math.floor(fraction / wedgeWidth);
  if (idx < 0) idx = 0;
  if (idx >= channels.length) idx = channels.length - 1;
  return channels[idx];
}

/**
 * Apply wedge-boundary hysteresis: once we've committed to a channel,
 * require the fraction to be at least WEDGE_ENTRY_HYSTERESIS *inside*
 * a different wedge before we switch.
 */
function pickChannelWithHysteresis(
  fraction: number,
  channels: ChannelInfo[]
): ChannelInfo | null {
  const naive = pickChannelFromFraction(fraction, channels);
  if (!naive) return null;
  if (lastAppliedChannelNumber === null) return naive;
  if (naive.number === lastAppliedChannelNumber) return naive;

  const wedgeWidth = 1 / channels.length;
  const naiveIdx = channels.indexOf(naive);
  const wedgeStart = naiveIdx * wedgeWidth;
  const depthIntoWedge = (fraction - wedgeStart) / wedgeWidth;

  const currentIdx = channels.findIndex(
    (c) => c.number === lastAppliedChannelNumber
  );
  if (currentIdx < 0) return naive;

  const inside =
    naiveIdx > currentIdx ? depthIntoWedge : 1 - depthIntoWedge;

  if (inside < WEDGE_ENTRY_HYSTERESIS) {
    const current = channels.find(
      (c) => c.number === lastAppliedChannelNumber
    );
    return current ?? naive;
  }
  return naive;
}

/**
 * Read STATUS + AGC and log any transition (e.g. magnet lost). Skipped
 * on most polls; runs once per HEALTH_CHECK_INTERVAL to keep the I2C
 * bus quiet during normal operation.
 */
function checkMagnetHealth(): void {
  const status = i2cReadReg(AS5600_ADDR, AS5600_REG_STATUS, 1);
  if (!status) return;
  const md = !!(status[0] & AS5600_STATUS_MD);
  const ml = !!(status[0] & AS5600_STATUS_ML);
  const mh = !!(status[0] & AS5600_STATUS_MH);
  const label = !md ? "NOT DETECTED" : mh ? "TOO STRONG" : ml ? "TOO WEAK" : "OK";
  if (label !== lastMagnetLabel) {
    if (lastMagnetLabel !== null) {
      const agc = i2cReadReg(AS5600_ADDR, AS5600_REG_AGC, 1);
      const agcVal = agc ? agc[0] : NaN;
      console.log(
        `[Tuner] AS5600 magnet ${lastMagnetLabel} → ${label} (AGC=${agcVal})`
      );
    }
    lastMagnetLabel = label;
  }
}

// ── Poll loop ──────────────────────────────────────────────────────────

function pollTuner(): void {
  pollTick = (pollTick + 1) % HEALTH_CHECK_INTERVAL;
  if (pollTick === 0) checkMagnetHealth();

  const raw = readAngle();
  if (raw === null) return;

  const smoothed = smoothAngle(raw);
  const fraction = angleToFraction(smoothed);

  // Broadcast the live fraction to the web UI regardless of whether the
  // channel actually changes.
  radioState.setTuner(fraction, Math.round(smoothed), currentBand);

  // Wait for the smoothing buffer to fill before committing to a channel.
  if (rawHistory.length < SMOOTH_WINDOW) return;

  // Only reconsider the channel selection if the fraction moved enough.
  if (
    lastCommittedFraction !== null &&
    Math.abs(fraction - lastCommittedFraction) < FRACTION_HYSTERESIS
  ) {
    return;
  }

  const channels = channelsForBand(currentBand);
  const pick = pickChannelWithHysteresis(fraction, channels);
  if (!pick) return;

  if (pick.number !== lastAppliedChannelNumber) {
    // Only log the "picked channel" line when the radio is actually in a
    // state where the choice matters.
    if (radioState.state.mode === "radio" && radioState.state.power) {
      console.log(
        `[Tuner] band=${currentBand.toString(16)} fraction=${fraction.toFixed(
          3
        )} → channel ${pick.number} – ${pick.name}`
      );
    }
    lastAppliedChannelNumber = pick.number;
    radioState.setChannel(pick);
  }
  lastCommittedFraction = fraction;
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Update the current band nibble. Called from gpio.ts whenever the top
 * nibble of the channel selector switch changes.
 */
export function setTunerBand(nibble: number): void {
  const masked = nibble & 0x0f;
  if (masked === currentBand) return;
  currentBand = masked;
  lastAppliedChannelNumber = null;
  lastCommittedFraction = null;
}

/**
 * Capture the current angle reading as the min or max calibration point.
 */
export function calibrateTuner(kind: "min" | "max"): number | null {
  const raw = readAngle();
  if (raw === null) return null;
  if (kind === "min") {
    calib.minAngle = raw;
  } else {
    calib.maxAngle = raw;
  }
  saveCalibration();
  rawHistory.length = 0;
  lastAppliedChannelNumber = null;
  lastCommittedFraction = null;
  return raw;
}

/**
 * Toggle the "invert" flag in calibration.
 */
export function invertTuner(invert: boolean): void {
  if (calib.invert === invert) return;
  calib.invert = invert;
  saveCalibration();
  lastAppliedChannelNumber = null;
  lastCommittedFraction = null;
}

/**
 * Read-only snapshot of the tuner state — used by the debug API.
 */
export function tunerStatus(): {
  ready: boolean;
  calibration: Calibration & { minRaw?: number; maxRaw?: number };
  latestRaw: number | null;
  fraction: number | null;
  band: number;
  channelsInBand: Array<{ number: number; name: string }>;
} {
  const channels = channelsForBand(currentBand);
  // Include legacy minRaw/maxRaw aliases so any existing debug UI or
  // status consumers keep rendering.
  const cal = {
    ...calib,
    minRaw: calib.minAngle,
    maxRaw: calib.maxAngle,
  };
  return {
    ready: !devMode && sensorPresent,
    calibration: cal,
    latestRaw: radioState.state.tunerRaw,
    fraction: radioState.state.tunerFraction,
    band: currentBand,
    channelsInBand: channels.map((c) => ({ number: c.number, name: c.name })),
  };
}

/**
 * True if the tuner is running (sensor present, poll loop started).
 */
export function isTunerActive(): boolean {
  return !devMode && pollTimer !== null && sensorPresent;
}

export function initTuner(): void {
  if (!isAdcReady()) {
    devMode = true;
    console.log("[Tuner] I2C not available — running in dev mode");
    return;
  }

  loadCalibration();

  // Probe the AS5600 and read once. If the chip isn't on the bus we
  // silently disable the tuner so gpio.ts falls back to the classic
  // full-8-bit channel lookup.
  if (!i2cProbe(AS5600_ADDR)) {
    console.log(
      "[Tuner] AS5600 not found at 0x36 — falling back to classic GPIO channel lookup"
    );
    devMode = true;
    return;
  }
  console.log("[Tuner] AS5600 found at 0x36");
  sensorPresent = true;

  // Initial magnet-health snapshot
  const status = i2cReadReg(AS5600_ADDR, AS5600_REG_STATUS, 1);
  const agc = i2cReadReg(AS5600_ADDR, AS5600_REG_AGC, 1);
  const magnitude = i2cReadReg(AS5600_ADDR, AS5600_REG_MAGNITUDE, 2);
  if (status) {
    const md = !!(status[0] & AS5600_STATUS_MD);
    const ml = !!(status[0] & AS5600_STATUS_ML);
    const mh = !!(status[0] & AS5600_STATUS_MH);
    lastMagnetLabel = !md
      ? "NOT DETECTED"
      : mh
      ? "TOO STRONG"
      : ml
      ? "TOO WEAK"
      : "OK";
    const agcVal = agc ? agc[0] : NaN;
    const magVal = magnitude
      ? ((magnitude[0] << 8) | magnitude[1]) & 0x0fff
      : NaN;
    console.log(
      `[Tuner] Magnet=${lastMagnetLabel} AGC=${agcVal} magnitude=${magVal}`
    );
  }

  const initial = readAngle();
  if (initial !== null) {
    const fraction = angleToFraction(initial);
    radioState.setTuner(fraction, initial, currentBand);
    console.log(
      `[Tuner] Initial angle: raw=${initial} fraction=${fraction.toFixed(3)}`
    );
  } else {
    console.log("[Tuner] Initial angle read failed — polling anyway");
  }

  pollTimer = setInterval(pollTuner, TUNER_POLL_MS);
  console.log(
    `[Tuner] Polling AS5600 every ${TUNER_POLL_MS}ms, smoothing window=${SMOOTH_WINDOW}`
  );
}

export function stopTuner(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  sensorPresent = false;
  if (!devMode) {
    console.log("[Tuner] Stopped");
  }
}
