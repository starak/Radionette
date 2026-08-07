/**
 * Shared ADS1115 service.
 *
 * Multiple modules (volume, tuner) read different single-ended channels
 * on the same physical ADC over I2C bus 1. This module owns the fd, the
 * ioctl slave address, and the low-level convert/read sequence.
 *
 * Operating mode: single-shot conversions. We set the CONFIG register
 * per channel with OS=1 and MODE=1 (single-shot), then read the
 * conversion register once the conversion completes.
 *
 * The ADS1115 has no ready pin exposed on the breakout, so we sleep a
 * conservative interval instead of polling the config OS bit.
 *
 * Public API is intentionally sync-callback-free: callers pass a channel
 * mux code (see ADC_MUX_AINn constants), get back a raw 16-bit signed
 * integer or null on error. Detection happens once at initAdc().
 */

import { openSync, readSync, writeSync, closeSync } from "fs";

// ── I2C constants ──────────────────────────────────────────────────────

const I2C_BUS = "/dev/i2c-1";
const I2C_SLAVE = 0x0703;

// ADS1115 has 4 possible addresses depending on ADDR pin wiring:
//   0x48 = ADDR→GND, 0x49 = ADDR→VDD, 0x4a = ADDR→SDA, 0x4b = ADDR→SCL
const ADS1115_ADDRS = [0x48, 0x49, 0x4a, 0x4b];

const REG_CONVERSION = 0x00;
const REG_CONFIG = 0x01;

// ADS1115 CONFIG bit fields (16-bit register):
//   15    OS     1 = start single conversion (write); 1 = ready (read)
//   14-12 MUX    input multiplexer (see below)
//   11-9  PGA    gain (see below)
//   8     MODE   0 = continuous, 1 = single-shot
//   7-5   DR     data rate (see below)
//   4-0   comparator settings (unused here)
//
// We compose a per-channel config from these constants.

// Single-ended MUX codes (for AINx vs GND):
export const ADC_MUX_AIN0 = 0b100;
export const ADC_MUX_AIN1 = 0b101;
export const ADC_MUX_AIN2 = 0b110;
export const ADC_MUX_AIN3 = 0b111;

// PGA = 001 → FS = ±4.096 V (safe for 3V3 sources like our pot and AS5600)
const PGA_4V096 = 0b001;

// DR = 100 → 128 SPS (nominal 7.8 ms per conversion; we sleep 10 ms).
const DR_128SPS = 0b100;

// COMP_QUE = 11 → comparator disabled
const COMP_DISABLED = 0b11;

/**
 * Build a CONFIG register value for a single-shot conversion on the
 * given mux code. OS=1 kicks off the conversion.
 */
function buildConfig(mux: number): number {
  return (
    (1 << 15) |                // OS = 1 (start conversion)
    ((mux & 0b111) << 12) |    // MUX
    ((PGA_4V096 & 0b111) << 9) |
    (1 << 8) |                 // MODE = 1 (single-shot)
    ((DR_128SPS & 0b111) << 5) |
    (COMP_DISABLED & 0b11)     // COMP_QUE bits
  );
}

// Conservative wait after triggering a single-shot conversion at 128 SPS.
// Nominal is 7.8 ms; we sleep 10 ms to leave margin for OS jitter.
const CONVERSION_WAIT_MS = 10;

// ── Module state ───────────────────────────────────────────────────────

let ioctl:
  | ((fd: number, request: number, value: number) => void)
  | null = null;
try {
  ioctl = require("ioctl");
} catch {
  ioctl = null;
}

let i2cFd: number | null = null;
let deviceAddr: number | null = null;
let currentSlave: number | null = null;

// ── Helpers ────────────────────────────────────────────────────────────

function selectSlave(addr: number): boolean {
  if (i2cFd === null || !ioctl) return false;
  if (currentSlave === addr) return true;
  try {
    ioctl(i2cFd, I2C_SLAVE, addr);
    currentSlave = addr;
    return true;
  } catch {
    return false;
  }
}

function sleepMs(ms: number): void {
  // Small synchronous busy-wait; the ADS1115 conversion is short and
  // volume/tuner polling runs on a 100 ms setInterval so blocking briefly
  // is fine and simpler than restructuring the poll loop.
  const start = Date.now();
  while (Date.now() - start < ms) {
    // spin
  }
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Open /dev/i2c-1, scan the four possible ADS1115 addresses by writing a
 * benign single-shot config and reading it back. First address that
 * verifies wins. Returns true on success.
 */
export function initAdc(): boolean {
  if (!ioctl) {
    console.log("[ADC] ioctl module not available — running without I2C");
    return false;
  }

  try {
    i2cFd = openSync(I2C_BUS, "r+");
  } catch (err: any) {
    console.log(`[ADC] Cannot open I2C bus: ${err.message}`);
    return false;
  }

  const probeConfig = buildConfig(ADC_MUX_AIN0);
  const configBuf = Buffer.from([
    REG_CONFIG,
    (probeConfig >> 8) & 0xff,
    probeConfig & 0xff,
  ]);

  for (const addr of ADS1115_ADDRS) {
    try {
      ioctl!(i2cFd, I2C_SLAVE, addr);
      currentSlave = addr;

      // Write probe config
      writeSync(i2cFd, configBuf);

      // Read it back
      writeSync(i2cFd, Buffer.from([REG_CONFIG]));
      const readBuf = Buffer.alloc(2);
      readSync(i2cFd, readBuf, 0, 2, null);
      const readBack = (readBuf[0] << 8) | readBuf[1];

      // OS bit (15) is 1 after a single-shot conversion completes and 0
      // while it's running. Mask it out for comparison; also mask reserved
      // low bits that some clones return with slight noise.
      const expected = probeConfig & 0x7fe0;
      const actual = readBack & 0x7fe0;
      if (actual !== expected) continue;

      deviceAddr = addr;
      console.log(`[ADC] ADS1115 found at 0x${addr.toString(16)}`);
      return true;
    } catch {
      // try next address
    }
  }

  try {
    closeSync(i2cFd);
  } catch {}
  i2cFd = null;
  currentSlave = null;
  console.log("[ADC] ADS1115 not found on I2C bus 1 (scanned 0x48-0x4b)");
  return false;
}

/**
 * Read a single ADS1115 channel. Blocks for ~10 ms while the ADC
 * completes a single-shot conversion. Returns the raw signed 16-bit
 * value, or null on error.
 */
export function readAdcChannel(mux: number): number | null {
  if (i2cFd === null || deviceAddr === null) return null;
  if (!selectSlave(deviceAddr)) return null;

  const config = buildConfig(mux);

  try {
    // Start single-shot conversion for this channel
    writeSync(
      i2cFd,
      Buffer.from([REG_CONFIG, (config >> 8) & 0xff, config & 0xff])
    );
  } catch (err: any) {
    console.error(`[ADC] Write config failed (mux=${mux}): ${err.message}`);
    return null;
  }

  sleepMs(CONVERSION_WAIT_MS);

  try {
    // Point at conversion register and read 2 bytes
    writeSync(i2cFd, Buffer.from([REG_CONVERSION]));
    const buf = Buffer.alloc(2);
    readSync(i2cFd, buf, 0, 2, null);
    const raw16 = (buf[0] << 8) | buf[1];
    // Single-ended reads are always non-negative in practice, but the
    // register is 16-bit two's complement. Sign-extend correctly.
    return raw16 >= 0x8000 ? raw16 - 0x10000 : raw16;
  } catch (err: any) {
    console.error(`[ADC] Read conversion failed (mux=${mux}): ${err.message}`);
    return null;
  }
}

/**
 * True if the ADC was found and is ready to read.
 */
export function isAdcReady(): boolean {
  return i2cFd !== null && deviceAddr !== null;
}

// ── Generic I2C helpers for OTHER devices on the same bus ──────────────
//
// The AS5600 also sits on /dev/i2c-1 (address 0x36). Rather than have it
// open its own fd, the tuner reuses ours. These helpers let any caller
// address an arbitrary slave, do a register write and a register read.

/**
 * Return true if a device at `addr` ACKs a zero-length write. Used to
 * probe for optional devices (e.g. AS5600) without polluting the log
 * with error output. Returns false if the ADC isn't open, ioctl fails,
 * or the device doesn't respond.
 */
export function i2cProbe(addr: number): boolean {
  if (i2cFd === null || !ioctl) return false;
  try {
    ioctl(i2cFd, I2C_SLAVE, addr);
    currentSlave = addr;
    // Zero-length write: some kernels accept this, some don't. Fall back
    // to a 1-byte "point at register 0" write which every device tolerates.
    writeSync(i2cFd, Buffer.from([0x00]));
    return true;
  } catch {
    return false;
  }
}

/**
 * Write bytes to a device on the bus. First byte is typically the
 * register address, followed by data bytes. Returns true on success.
 */
export function i2cWriteTo(addr: number, bytes: Buffer | number[]): boolean {
  if (i2cFd === null || !ioctl) return false;
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  try {
    ioctl(i2cFd, I2C_SLAVE, addr);
    currentSlave = addr;
    writeSync(i2cFd, buf);
    return true;
  } catch (err: any) {
    console.error(
      `[ADC] i2cWriteTo(0x${addr.toString(16)}) failed: ${err.message}`
    );
    return false;
  }
}

/**
 * Register-read pattern: write a single register-address byte, then
 * read `length` bytes back. Returns the read bytes as a Buffer, or
 * null on failure.
 */
export function i2cReadReg(
  addr: number,
  register: number,
  length: number
): Buffer | null {
  if (i2cFd === null || !ioctl) return null;
  try {
    ioctl(i2cFd, I2C_SLAVE, addr);
    currentSlave = addr;
    writeSync(i2cFd, Buffer.from([register & 0xff]));
    const buf = Buffer.alloc(length);
    readSync(i2cFd, buf, 0, length, null);
    return buf;
  } catch (err: any) {
    console.error(
      `[ADC] i2cReadReg(0x${addr.toString(16)},0x${register.toString(16)}) failed: ${err.message}`
    );
    return null;
  }
}

/**
 * Close the fd. Called from shutdown paths.
 */
export function stopAdc(): void {
  if (i2cFd !== null) {
    try {
      closeSync(i2cFd);
    } catch {}
    i2cFd = null;
  }
  deviceAddr = null;
  currentSlave = null;
}
