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
 *  - Combine fraction + current band ordinal (from gpio.ts) to pick a
 *    concrete channel from channels.json and call radioState.setChannel.
 *    An empty band (no channels, or the hardware nibble maps to no
 *    band) results in setChannel(null) — silence.
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

// Default calibration if no file exists yet, in 12-bit angle counts
// (0..4095). Real values come from calibrating via the debug UI.
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

let lastAppliedChannelId: string | null = null;
let lastCommittedFraction: number | null = null;

/**
 * Current band ordinal (from channels.json). 0 means "no band" — either
 * gpio.ts hasn't reported anything yet, or the current hardware nibble
 * maps to no configured band.
 */
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
    const parsed = JSON.parse(raw) as Partial<Calibration>;
    if (
      typeof parsed.minAngle === "number" &&
      typeof parsed.maxAngle === "number" &&
      parsed.minAngle !== parsed.maxAngle &&
      parsed.minAngle >= 0 &&
      parsed.maxAngle >= 0
    ) {
      calib = {
        minAngle: parsed.minAngle,
        maxAngle: parsed.maxAngle,
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
 * before averaging.
 */
function smoothAngle(raw: number): number {
  rawHistory.push(raw);
  if (rawHistory.length > SMOOTH_WINDOW) rawHistory.shift();
  if (rawHistory.length === 1) return raw;

  const ref = rawHistory[0];
  let sum = 0;
  for (const v of rawHistory) {
    let d = v - ref;
    if (d > 2048) d -= 4096;
    else if (d < -2048) d += 4096;
    sum += ref + d;
  }
  const avg = sum / rawHistory.length;
  return ((avg % 4096) + 4096) % 4096;
}

/**
 * Convert a smoothed 12-bit angle (0..4095) into a fraction in [0,1]
 * across the calibrated sweep. Correctly handles calibrations that
 * straddle the 0/4095 wrap point (minAngle > maxAngle in raw terms).
 */
function angleToFraction(angle: number): number {
  const { minAngle, maxAngle, invert } = calib;

  const arcTo = (target: number): number => {
    let d = target - minAngle;
    if (d < 0) d += 4096;
    return d;
  };

  const total = arcTo(maxAngle);
  if (total === 0) return 0;

  let t = arcTo(angle) / total;
  if (t > 1) {
    const distToMin = 4096 - arcTo(angle);
    const distToMax = arcTo(angle) - total;
    t = distToMax < distToMin ? 1 : 0;
  }
  if (t < 0) t = 0;
  return invert ? 1 - t : t;
}

/**
 * Given a fractional needle position in [0,1] and a list of channels
 * (pre-sorted by `order`), return the channel whose wedge contains
 * the needle. Wedges are equal-width; a band of N channels fills the
 * full 0..1 sweep regardless of N.
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
  if (lastAppliedChannelId === null) return naive;
  if (naive.id === lastAppliedChannelId) return naive;

  const wedgeWidth = 1 / channels.length;
  const naiveIdx = channels.indexOf(naive);
  const wedgeStart = naiveIdx * wedgeWidth;
  const depthIntoWedge = (fraction - wedgeStart) / wedgeWidth;

  const currentIdx = channels.findIndex(
    (c) => c.id === lastAppliedChannelId
  );
  if (currentIdx < 0) return naive;

  const inside =
    naiveIdx > currentIdx ? depthIntoWedge : 1 - depthIntoWedge;

  if (inside < WEDGE_ENTRY_HYSTERESIS) {
    const current = channels.find(
      (c) => c.id === lastAppliedChannelId
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

/** Push channel=null through radioState if we're currently on something. */
function commitSilence(): void {
  if (lastAppliedChannelId !== null) {
    if (radioState.state.mode === "radio" && radioState.state.power) {
      console.log(
        `[Tuner] band=${currentBand} has no channels — silence`
      );
    }
    lastAppliedChannelId = null;
    radioState.setChannel(null);
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

  radioState.setTuner(fraction, Math.round(smoothed), currentBand);

  if (rawHistory.length < SMOOTH_WINDOW) return;

  if (
    lastCommittedFraction !== null &&
    Math.abs(fraction - lastCommittedFraction) < FRACTION_HYSTERESIS
  ) {
    return;
  }

  const channels = channelsForBand(currentBand);
  if (channels.length === 0) {
    commitSilence();
    lastCommittedFraction = fraction;
    return;
  }

  const pick = pickChannelWithHysteresis(fraction, channels);
  if (!pick) {
    commitSilence();
    lastCommittedFraction = fraction;
    return;
  }

  if (pick.id !== lastAppliedChannelId) {
    if (radioState.state.mode === "radio" && radioState.state.power) {
      console.log(
        `[Tuner] band=${currentBand} fraction=${fraction.toFixed(
          3
        )} → ${pick.id} (${pick.name})`
      );
    }
    lastAppliedChannelId = pick.id;
    radioState.setChannel(pick);
  }
  lastCommittedFraction = fraction;
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Update the current band ordinal. Called from gpio.ts whenever the top
 * nibble of the channel selector switch changes. Pass 0 to signal
 * "unmapped band" (silence).
 */
export function setTunerBand(bandOrdinal: number): void {
  const b = bandOrdinal | 0;
  if (b === currentBand) return;
  currentBand = b;
  lastAppliedChannelId = null;
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
  lastAppliedChannelId = null;
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
  lastAppliedChannelId = null;
  lastCommittedFraction = null;
}

/**
 * Read-only snapshot of the tuner state — used by the debug API.
 */
export function tunerStatus(): {
  ready: boolean;
  calibration: Calibration;
  latestRaw: number | null;
  fraction: number | null;
  band: number;
  channelsInBand: Array<{ id: string; name: string; order: number }>;
} {
  const channels = channelsForBand(currentBand);
  return {
    ready: !devMode && sensorPresent,
    calibration: { ...calib },
    latestRaw: radioState.state.tunerRaw,
    fraction: radioState.state.tunerFraction,
    band: currentBand,
    channelsInBand: channels.map((c) => ({
      id: c.id,
      name: c.name,
      order: c.order,
    })),
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

  if (!i2cProbe(AS5600_ADDR)) {
    console.log(
      "[Tuner] AS5600 not found at 0x36 — gpio.ts fallback will pick first channel in the current band"
    );
    devMode = true;
    return;
  }
  console.log("[Tuner] AS5600 found at 0x36");
  sensorPresent = true;

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
