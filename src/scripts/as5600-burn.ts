/**
 * One-shot AS5600 OTP burn script.
 *
 * The AS5600 defaults to PWM on its OUT pin at every power-up. To make
 * it come up in analog mode without needing I2C wires in the finished
 * radio, we permanently store OUTS=00 (analog full 0..VDD) in the
 * chip's OTP by issuing BURN_SETTING once. After the burn, remove
 * SDA/SCL and the OUT pin will emit analog on every future boot.
 *
 * ⚠ Read this before running:
 *
 *   - BURN_SETTING can be executed exactly ONE time in the chip's life.
 *     There is no undo. Cheap AS5600 breakouts sometimes ship
 *     pre-burned by the vendor.
 *   - BURN_SETTING also permanently stores MANG (max angle). This
 *     script forces MANG to 0xFFF (full 360°) before the burn so a
 *     partially-configured chip doesn't get locked to a truncated
 *     range.
 *   - The datasheet requires the magnet to be present (STATUS.MD = 1)
 *     for the burn to succeed. This script aborts if MD = 0.
 *   - This script requires interactive confirmation: pass the token
 *     BURN as the first argv to actually execute the burn. Without it,
 *     the script prints what it WOULD do and exits.
 *
 * Usage on the Pi (SDA/SCL temporarily wired to Pi GPIO 2 / 3):
 *
 *   pm2 stop radionette
 *   cd ~/code
 *   node dist/scripts/as5600-burn.js         # dry run — read + print
 *   node dist/scripts/as5600-burn.js BURN    # actually burn (irreversible)
 *   pm2 start radionette
 *
 * After the burn, power-cycle the AS5600 (unplug the Pi or the sensor
 * VDD wire) so it reloads OTP into its live config registers.
 */

import { closeSync, openSync, readSync, writeSync } from "fs";

// require() so the script runs even if @types/ioctl is missing.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ioctl: (fd: number, request: number, value: number) => void = require("ioctl");

const I2C_BUS = "/dev/i2c-1";
const I2C_SLAVE = 0x0703;

const AS5600_ADDR = 0x36;

// Register map (datasheet Table 20)
const REG_ZMCO = 0x00;      // burn counters: bits 1:0 = ZMCO
const REG_ZPOS = 0x01;      // 12-bit start position (2 bytes)
const REG_MPOS = 0x03;      // 12-bit stop position (2 bytes)
const REG_MANG = 0x05;      // 12-bit max angle (2 bytes)
const REG_CONF = 0x07;      // 16-bit config
const REG_RAW_ANGLE = 0x0c; // 12-bit raw angle
const REG_ANGLE = 0x0e;     // 12-bit filtered angle
const REG_STATUS = 0x0b;
const REG_AGC = 0x1a;
const REG_MAGNITUDE = 0x1b; // 2 bytes
const REG_BURN = 0xff;

const BURN_SETTING = 0x40;

const STATUS_MD = 1 << 5;
const STATUS_ML = 1 << 4;
const STATUS_MH = 1 << 3;

// CONF register (big-endian):
//   High byte: bits 13:8 -> WD | FTH[2:0] | SF[1:0]
//   Low  byte: bits  7:0 -> PWMF[1:0] | OUTS[1:0] | HYST[1:0] | PM[1:0]
const CONF_OUTS_MASK_LO = 0b0000_1100;      // bits 3:2 of the low byte
const CONF_OUTS_ANALOG_FULL_LO = 0b0000_0000; // OUTS = 00

// ── Low-level I2C helpers ──────────────────────────────────────────────

let fd: number = -1;

function open(): void {
  fd = openSync(I2C_BUS, "r+");
  ioctl(fd, I2C_SLAVE, AS5600_ADDR);
}

function close(): void {
  if (fd >= 0) {
    try { closeSync(fd); } catch { /* ignore */ }
    fd = -1;
  }
}

function readReg(reg: number, length: number): Buffer {
  writeSync(fd, Buffer.from([reg & 0xff]));
  const buf = Buffer.alloc(length);
  readSync(fd, buf, 0, length, null);
  return buf;
}

function writeReg(reg: number, bytes: number[]): void {
  writeSync(fd, Buffer.from([reg & 0xff, ...bytes]));
}

function sleepMs(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* spin */ }
}

// ── Domain helpers ─────────────────────────────────────────────────────

function readStatus(): { md: boolean; ml: boolean; mh: boolean; raw: number } {
  const buf = readReg(REG_STATUS, 1);
  return {
    md: !!(buf[0] & STATUS_MD),
    ml: !!(buf[0] & STATUS_ML),
    mh: !!(buf[0] & STATUS_MH),
    raw: buf[0],
  };
}

function magnetLabel(s: { md: boolean; ml: boolean; mh: boolean }): string {
  if (!s.md) return "NOT DETECTED";
  if (s.mh) return "TOO STRONG";
  if (s.ml) return "TOO WEAK";
  return "OK";
}

function read12(reg: number): number {
  const b = readReg(reg, 2);
  return ((b[0] << 8) | b[1]) & 0x0fff;
}

function readConf(): { raw: number; hi: number; lo: number } {
  const b = readReg(REG_CONF, 2);
  return { raw: (b[0] << 8) | b[1], hi: b[0], lo: b[1] };
}

function readZmco(): number {
  return readReg(REG_ZMCO, 1)[0] & 0b11;
}

function readMagnitude(): number {
  const b = readReg(REG_MAGNITUDE, 2);
  return ((b[0] << 8) | b[1]) & 0x0fff;
}

function readAgc(): number {
  return readReg(REG_AGC, 1)[0];
}

function hex(n: number, width = 2): string {
  return "0x" + n.toString(16).padStart(width, "0");
}

// ── Main ───────────────────────────────────────────────────────────────

function printSummary(prefix: string): void {
  const status = readStatus();
  const conf = readConf();
  const mang = read12(REG_MANG);
  const zpos = read12(REG_ZPOS);
  const mpos = read12(REG_MPOS);
  const angle = read12(REG_ANGLE);
  const raw = read12(REG_RAW_ANGLE);
  const agc = readAgc();
  const magnitude = readMagnitude();
  const zmco = readZmco();
  const outsBits = (conf.lo & CONF_OUTS_MASK_LO) >> 2;
  const outsLabel =
    outsBits === 0b00 ? "analog full (0..VDD)" :
    outsBits === 0b01 ? "analog reduced (10..90% VDD)" :
    outsBits === 0b10 ? "digital PWM" :
    "reserved";

  console.log(`${prefix}`);
  console.log(`  STATUS      = ${hex(status.raw)}  magnet=${magnetLabel(status)}  MD=${status.md ? 1 : 0} ML=${status.ml ? 1 : 0} MH=${status.mh ? 1 : 0}`);
  console.log(`  AGC         = ${agc}  (target 128; higher = weaker magnet)`);
  console.log(`  MAGNITUDE   = ${magnitude}`);
  console.log(`  RAW_ANGLE   = ${raw}  (0..4095)`);
  console.log(`  ANGLE       = ${angle}`);
  console.log(`  ZPOS/MPOS   = ${zpos} / ${mpos}`);
  console.log(`  MANG        = ${mang}  (0xFFF = full 360° = default)`);
  console.log(`  CONF        = ${hex(conf.raw, 4)}  hi=${hex(conf.hi)} lo=${hex(conf.lo)}`);
  console.log(`  OUTS bits   = 0b${outsBits.toString(2).padStart(2, "0")}  (${outsLabel})`);
  console.log(`  ZMCO        = ${zmco}  (0 = never burned, 3 = burned max times)`);
}

function main(): void {
  const doBurn = process.argv.includes("BURN");

  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║              AS5600 OTP BURN — analog output                 ║");
  console.log("╠══════════════════════════════════════════════════════════════╣");
  console.log("║ Mode: " + (doBurn ? "!! BURN !!  (irreversible)                          " : "dry run  (add BURN as an argument to actually burn)  ") + "║");
  console.log("╚══════════════════════════════════════════════════════════════╝");

  try {
    open();
  } catch (err: any) {
    console.error(`Failed to open ${I2C_BUS}: ${err.message}`);
    console.error("Is I2C enabled?  (dtparam=i2c_arm=on in /boot/firmware/config.txt)");
    process.exit(1);
  }

  // Read pre-burn state
  try {
    printSummary("BEFORE:");
  } catch (err: any) {
    console.error(`Failed to read AS5600 at 0x36: ${err.message}`);
    console.error("Check SDA/SCL wiring to the Pi (GPIO 2 = pin 3, GPIO 3 = pin 5).");
    close();
    process.exit(1);
  }

  const status = readStatus();

  if (!status.md) {
    console.error("");
    console.error("✗ Magnet not detected (STATUS.MD = 0).");
    console.error("  BURN_SETTING will fail with no magnet present. Fit the magnet");
    console.error("  above the AS5600 (0.5..3 mm, on-axis) and try again.");
    close();
    process.exit(1);
  }

  if (status.mh || status.ml) {
    console.warn("");
    console.warn(`! Magnet flagged as ${magnetLabel(status)}. Proceeding anyway,`);
    console.warn("  but AGC will not sit at ~128 and the OUT signal may be noisy.");
    console.warn("  Consider adjusting magnet distance before burning.");
  }

  const zmco = readZmco();
  if (zmco >= 3) {
    console.error("");
    console.error("✗ ZMCO = 3 — this AS5600 has already been burned the maximum");
    console.error("  number of times. Cannot burn again.");
    close();
    process.exit(1);
  }

  // Force MANG = 0xFFF (full 360°) so the burn doesn't lock the chip to
  // a truncated angular range if some previous session set it.
  const currentMang = read12(REG_MANG);
  if (currentMang !== 0xfff) {
    console.log("");
    console.log(`Setting MANG 0x${currentMang.toString(16)} -> 0xFFF (full 360°) before burn`);
    if (doBurn) {
      writeReg(REG_MANG, [0x0f, 0xff]);
      sleepMs(2);
    }
  }

  // Read CONF, set OUTS=00 (analog full), keep other bits.
  const conf = readConf();
  const desiredLo = (conf.lo & ~CONF_OUTS_MASK_LO) | CONF_OUTS_ANALOG_FULL_LO;
  if (desiredLo !== conf.lo) {
    console.log("");
    console.log(`Setting CONF lo byte ${hex(conf.lo)} -> ${hex(desiredLo)} (OUTS=00 analog full)`);
    if (doBurn) {
      writeReg(REG_CONF, [conf.hi, desiredLo]);
      sleepMs(2);
    }
  }

  if (!doBurn) {
    console.log("");
    console.log("── dry run complete ─────────────────────────────────────────────");
    console.log("This is what would happen if you re-ran with the BURN argument:");
    console.log("  1. Ensure MANG = 0xFFF and CONF.OUTS = 00 in the live registers");
    console.log("  2. Write 0x40 to REG 0xFF (BURN_SETTING) — irreversible");
    console.log("  3. Wait 1 ms, verify the values by re-reading");
    console.log("");
    console.log("If everything above looks right, run:");
    console.log("  node dist/scripts/as5600-burn.js BURN");
    close();
    return;
  }

  // Confirm the state we're about to burn one more time from the live regs.
  console.log("");
  printSummary("AFTER pre-burn writes (verify these are correct BEFORE burning):");

  const confAfterPre = readConf();
  const outsAfterPre = (confAfterPre.lo & CONF_OUTS_MASK_LO) >> 2;
  const mangAfterPre = read12(REG_MANG);
  if (outsAfterPre !== 0b00) {
    console.error(`✗ OUTS bits are ${outsAfterPre.toString(2)} after pre-burn write — expected 00. Aborting burn.`);
    close();
    process.exit(1);
  }
  if (mangAfterPre !== 0xfff) {
    console.error(`✗ MANG is ${mangAfterPre.toString(16)} after pre-burn write — expected 0xFFF. Aborting burn.`);
    close();
    process.exit(1);
  }

  console.log("");
  console.log("Issuing BURN_SETTING (0x40 → reg 0xFF) …");
  writeReg(REG_BURN, [BURN_SETTING]);
  sleepMs(2);

  // Post-burn verification — the live regs should still hold the values
  // we just burned (the burn does not clear them).
  console.log("");
  printSummary("AFTER burn:");

  console.log("");
  console.log("✓ Burn command issued. Power-cycle the AS5600 (unplug and reconnect");
  console.log("  its VDD) to reload the OTP into the live registers. Then remove");
  console.log("  the SDA/SCL wires — they are no longer needed.");

  close();
}

main();
