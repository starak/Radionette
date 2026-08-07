/**
 * AS5600 magnetic angle sensor → ADS1115 analog tuner.
 *
 * The AS5600 sits on the needle shaft (single 180° sweep, no multi-turn
 * ambiguity). Its OUT pin is a ratiometric analog voltage proportional
 * to the angle, wired into the ADS1115 AIN1 input. We reuse the shared
 * ADC service (adc.ts) which volume.ts already opened.
 *
 * Responsibilities:
 *  - Poll AIN1 at TUNER_POLL_MS.
 *  - Persist / restore the two-point calibration (raw min ↔ raw max
 *    corresponding to the mechanical stops of the needle).
 *  - Convert raw → smoothed fraction in [0,1] across the calibrated span.
 *  - Combine fraction + current band nibble (from gpio.ts) to pick a
 *    concrete channel from channels.json and call radioState.setChannel.
 *
 * Calibration file lives at ~/.radionette/tuner-calibration.json and is
 * only rewritten when the user hits the calibrate endpoints (no periodic
 * writes needed — the sensor is absolute per revolution).
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  ADC_MUX_AIN1,
  isAdcReady,
  readAdcChannel,
  i2cProbe,
  i2cReadReg,
} from "./adc";
import { channelsForBand } from "./channels";
import { radioState, ChannelInfo } from "./state";

// ── AS5600 I2C diagnostics (optional) ──────────────────────────────────
//
// The intended production wiring is analog-only: OUT → ADS1115 AIN1,
// with SDA/SCL NOT connected once the AS5600 has been OTP-burned via
// `src/scripts/as5600-burn.ts` to make analog its power-up default.
//
// If SDA/SCL happen to be connected (e.g. during initial bring-up or
// while running the burn script), we take advantage of it and log
// magnet health at boot so you can spot bad magnet placement without
// a scope. When the chip isn't on the bus we stay silent.

const AS5600_ADDR = 0x36;
const AS5600_REG_STATUS = 0x0b;
const AS5600_REG_RAW_ANGLE = 0x0c;
const AS5600_REG_AGC = 0x1a;

const AS5600_STATUS_MD = 1 << 5; // magnet detected
const AS5600_STATUS_ML = 1 << 4; // magnet too weak
const AS5600_STATUS_MH = 1 << 3; // magnet too strong

/**
 * Log magnet-health diagnostics if the AS5600 responds on I2C. Silent
 * no-op when the chip isn't wired to SDA/SCL (the intended production
 * state after the OTP burn).
 */
function reportAs5600Health(): void {
  if (!i2cProbe(AS5600_ADDR)) {
    // Expected in production once SDA/SCL are removed — say nothing.
    return;
  }
  const status = i2cReadReg(AS5600_ADDR, AS5600_REG_STATUS, 1);
  if (!status) return;
  const agc = i2cReadReg(AS5600_ADDR, AS5600_REG_AGC, 1);
  const rawAngle = i2cReadReg(AS5600_ADDR, AS5600_REG_RAW_ANGLE, 2);

  const md = !!(status[0] & AS5600_STATUS_MD);
  const ml = !!(status[0] & AS5600_STATUS_ML);
  const mh = !!(status[0] & AS5600_STATUS_MH);
  const agcVal = agc ? agc[0] : NaN;
  const rawAngleVal = rawAngle
    ? ((rawAngle[0] << 8) | rawAngle[1]) & 0x0fff
    : NaN;

  const magnetLabel = md
    ? mh
      ? "TOO STRONG"
      : ml
      ? "TOO WEAK"
      : "OK"
    : "NOT DETECTED";
  console.log(
    `[Tuner] AS5600 present on I2C — magnet=${magnetLabel} AGC=${agcVal} rawAngle12bit=${rawAngleVal}`
  );
}

// ── Constants ──────────────────────────────────────────────────────────

const TUNER_POLL_MS = 50;

// Smoothing window for the raw ADC reading. At 50 ms poll, 6 samples =
// 300 ms of low-pass filtering — invisible to the ear/eye, kills jitter.
const SMOOTH_WINDOW = 6;

// Fractional deadband before we consider the position "changed enough"
// to reconsider which wedge the needle is in. Prevents flicker when the
// needle sits near a wedge boundary. 0.008 == 0.8% of full sweep.
const FRACTION_HYSTERESIS = 0.008;

// Additional wedge-boundary hysteresis: when the fraction crosses into
// a new wedge, require it to be at least this much *inside* the new
// wedge before we commit the change. Prevents rapid A↔B flicker at
// exact boundaries. Fraction of the wedge width.
const WEDGE_ENTRY_HYSTERESIS = 0.20;

// Fallback calibration if no file exists yet. Assumes AS5600 has been
// glued in a random orientation and swept both stops on first boot —
// which won't be true, so early behaviour will be "nothing works until
// you calibrate". The debug UI provides Set Min / Set Max buttons.
const DEFAULT_MIN_RAW = 0;
const DEFAULT_MAX_RAW = 26400;

const CALIB_FILE = path.join(os.homedir(), ".radionette", "tuner-calibration.json");

// ── State ──────────────────────────────────────────────────────────────

interface Calibration {
  minRaw: number;
  maxRaw: number;
  /**
   * If true, the fraction is inverted (1 - f) before use. Handy for
   * cases where the AS5600 DIR pin ended up wired to the opposite
   * polarity of what the software expects.
   */
  invert: boolean;
}

let calib: Calibration = {
  minRaw: DEFAULT_MIN_RAW,
  maxRaw: DEFAULT_MAX_RAW,
  invert: false,
};

let pollTimer: ReturnType<typeof setInterval> | null = null;
let devMode = false;

const rawHistory: number[] = [];

let lastAppliedChannelNumber: number | null = null;
let lastCommittedFraction: number | null = null;

// Current band nibble, updated by gpio.ts via setTunerBand().
let currentBand = 0;

// ── Helpers ────────────────────────────────────────────────────────────

function ensureCalibDir(): void {
  const dir = path.dirname(CALIB_FILE);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // ignore — file write will surface any real error
  }
}

function loadCalibration(): void {
  try {
    const raw = fs.readFileSync(CALIB_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Partial<Calibration>;
    if (
      typeof parsed.minRaw === "number" &&
      typeof parsed.maxRaw === "number" &&
      parsed.minRaw !== parsed.maxRaw
    ) {
      calib = {
        minRaw: parsed.minRaw,
        maxRaw: parsed.maxRaw,
        invert: !!parsed.invert,
      };
      console.log(
        `[Tuner] Loaded calibration: minRaw=${calib.minRaw} maxRaw=${calib.maxRaw} invert=${calib.invert}`
      );
      return;
    }
    console.log(`[Tuner] Calibration file present but invalid — using defaults`);
  } catch (err: any) {
    if (err.code !== "ENOENT") {
      console.log(`[Tuner] Could not read calibration file: ${err.message}`);
    }
    console.log(
      `[Tuner] Using default calibration (minRaw=${calib.minRaw} maxRaw=${calib.maxRaw}). Calibrate via the debug UI.`
    );
  }
}

function saveCalibration(): void {
  ensureCalibDir();
  try {
    fs.writeFileSync(CALIB_FILE, JSON.stringify(calib, null, 2), "utf-8");
    console.log(
      `[Tuner] Saved calibration: minRaw=${calib.minRaw} maxRaw=${calib.maxRaw} invert=${calib.invert}`
    );
  } catch (err: any) {
    console.error(`[Tuner] Failed to write calibration file: ${err.message}`);
  }
}

function smooth(raw: number): number {
  rawHistory.push(raw);
  if (rawHistory.length > SMOOTH_WINDOW) rawHistory.shift();
  const sum = rawHistory.reduce((a, b) => a + b, 0);
  return sum / rawHistory.length;
}

function rawToFraction(raw: number): number {
  const { minRaw, maxRaw, invert } = calib;
  if (maxRaw === minRaw) return 0;
  const rawSpan = maxRaw - minRaw;
  // Support inverted calibration (maxRaw < minRaw) by allowing negative
  // rawSpan too — clamp on either side after normalizing.
  const t = (raw - minRaw) / rawSpan;
  const bounded = Math.max(0, Math.min(1, t));
  return invert ? 1 - bounded : bounded;
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
 * a different wedge before we switch. Returns the chosen channel or
 * null if there's no station in the current band.
 */
function pickChannelWithHysteresis(
  fraction: number,
  channels: ChannelInfo[]
): ChannelInfo | null {
  const naive = pickChannelFromFraction(fraction, channels);
  if (!naive) return null;
  if (lastAppliedChannelNumber === null) return naive;

  // If naive pick already matches the currently committed channel,
  // nothing to do — no boundary to worry about.
  if (naive.number === lastAppliedChannelNumber) return naive;

  // We're crossing a boundary. Check how deep into the new wedge we are.
  const wedgeWidth = 1 / channels.length;
  const naiveIdx = channels.indexOf(naive);
  const wedgeStart = naiveIdx * wedgeWidth;
  const depthIntoWedge = (fraction - wedgeStart) / wedgeWidth;

  // Direction of travel: are we moving up (into a higher-index wedge) or
  // down? Use naive's index vs current committed index to know.
  const currentIdx = channels.findIndex(
    (c) => c.number === lastAppliedChannelNumber
  );
  if (currentIdx < 0) return naive;

  let inside: number;
  if (naiveIdx > currentIdx) {
    // Moving up — depth measures from the low edge of the new wedge
    inside = depthIntoWedge;
  } else {
    // Moving down — depth measures from the high edge of the new wedge
    inside = 1 - depthIntoWedge;
  }

  if (inside < WEDGE_ENTRY_HYSTERESIS) {
    // Not deep enough into the new wedge — stay on the current channel
    const current = channels.find(
      (c) => c.number === lastAppliedChannelNumber
    );
    return current ?? naive;
  }
  return naive;
}

// ── Poll loop ──────────────────────────────────────────────────────────

function pollTuner(): void {
  const raw = readAdcChannel(ADC_MUX_AIN1);
  if (raw === null) return;

  const smoothed = smooth(raw);
  const fraction = rawToFraction(smoothed);

  // Broadcast the live fraction to the web UI regardless of whether the
  // channel actually changes — the debug page uses this to move a needle.
  radioState.setTuner(fraction, Math.round(smoothed), currentBand);

  // Wait for the smoothing buffer to fill before committing to a channel.
  // Prevents a burst of channel changes at boot while successive-different
  // raw reads propagate through the average.
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
    // state where the choice matters. During power-off / bluetooth mode
    // setChannel() is a no-op and we'd just be spamming the log.
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
 * nibble of the channel selector switch changes. Forces a re-evaluation
 * of the current channel so switching bands takes effect immediately.
 */
export function setTunerBand(nibble: number): void {
  const masked = nibble & 0x0f;
  if (masked === currentBand) return;
  currentBand = masked;
  // Force re-pick on next poll: clear the committed channel so hysteresis
  // doesn't hold us on a station that no longer exists in this band.
  lastAppliedChannelNumber = null;
  lastCommittedFraction = null;
}

/**
 * Capture the current raw reading as the min or max calibration point.
 * Called from the debug endpoints when the user has the needle at a
 * mechanical stop.
 */
export function calibrateTuner(kind: "min" | "max"): number | null {
  const raw = readAdcChannel(ADC_MUX_AIN1);
  if (raw === null) return null;
  if (kind === "min") {
    calib.minRaw = raw;
  } else {
    calib.maxRaw = raw;
  }
  saveCalibration();
  // Reset history so the next reading isn't biased by the sample at the stop.
  rawHistory.length = 0;
  lastAppliedChannelNumber = null;
  lastCommittedFraction = null;
  return raw;
}

/**
 * Toggle the "invert" flag in calibration. Useful when the AS5600 DIR
 * pin ended up producing the wrong polarity for our software.
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
  calibration: Calibration;
  latestRaw: number | null;
  fraction: number | null;
  band: number;
  channelsInBand: Array<{ number: number; name: string }>;
} {
  const channels = channelsForBand(currentBand);
  return {
    ready: !devMode && isAdcReady(),
    calibration: { ...calib },
    latestRaw: radioState.state.tunerRaw,
    fraction: radioState.state.tunerFraction,
    band: currentBand,
    channelsInBand: channels.map((c) => ({ number: c.number, name: c.name })),
  };
}

/**
 * True if the tuner is running (ADC available, poll loop started). Used
 * by gpio.ts to decide whether to fall back to the old bit-decoded
 * channel selection.
 */
export function isTunerActive(): boolean {
  return !devMode && pollTimer !== null;
}

export function initTuner(): void {
  if (!isAdcReady()) {
    devMode = true;
    console.log("[Tuner] ADC not available — running in dev mode");
    return;
  }

  loadCalibration();

  // If SDA/SCL happen to be connected, log AS5600 magnet health for
  // diagnostics. In production the AS5600 is analog-only (SDA/SCL not
  // wired) after the OTP burn, so this is silent.
  reportAs5600Health();

  // Prime with a single read so state has a value at boot, but do NOT
  // pre-fill the smoothing buffer. That way the buffer-full gate in
  // pollTuner() waits for real successive reads before the tuner can
  // commit a channel change — this suppresses a boot-time sweep of
  // several channels while the initial reading (potentially taken while
  // the ADS1115 mux was still settling) is diluted out.
  const initial = readAdcChannel(ADC_MUX_AIN1);
  if (initial !== null) {
    const fraction = rawToFraction(initial);
    radioState.setTuner(fraction, initial, currentBand);
    console.log(
      `[Tuner] Initial reading: raw=${initial} fraction=${fraction.toFixed(3)}`
    );
  } else {
    console.log("[Tuner] Initial AIN1 read failed — polling anyway");
  }

  pollTimer = setInterval(pollTuner, TUNER_POLL_MS);
  console.log(
    `[Tuner] Polling AIN1 every ${TUNER_POLL_MS}ms, smoothing window=${SMOOTH_WINDOW}`
  );
}

export function stopTuner(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (!devMode) {
    console.log("[Tuner] Stopped");
  }
}
