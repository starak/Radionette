/**
 * Live AS5600 angle monitor.
 *
 * Prints RAW_ANGLE + STATUS every 100 ms so you can see the sensor react
 * to shaft motion in real time. Use this to find the actual mechanical
 * endpoints of the needle sweep before running the OTP burn, and to
 * spot-check magnet health.
 *
 * Requires I2C temporarily wired from AS5600 SDA/SCL to Pi GPIO 2/3.
 *
 * Usage on the Pi:
 *
 *   pm2 stop radionette
 *   cd ~/code
 *   node dist/scripts/as5600-monitor.js
 *
 * Ctrl-C to exit.
 */

import { closeSync, openSync, readSync, writeSync } from "fs";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const ioctl: (fd: number, request: number, value: number) => void = require("ioctl");

const I2C_BUS = "/dev/i2c-1";
const I2C_SLAVE = 0x0703;
const AS5600_ADDR = 0x36;

const REG_STATUS = 0x0b;
const REG_RAW_ANGLE = 0x0c;
const REG_AGC = 0x1a;
const REG_MAGNITUDE = 0x1b;

const STATUS_MD = 1 << 5;
const STATUS_ML = 1 << 4;
const STATUS_MH = 1 << 3;

const POLL_MS = 100;

let fd = -1;

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

function magnetLabel(status: number): string {
  const md = !!(status & STATUS_MD);
  const ml = !!(status & STATUS_ML);
  const mh = !!(status & STATUS_MH);
  if (!md) return "NO-MAGNET";
  if (mh) return "TOO-STRONG";
  if (ml) return "TOO-WEAK  ";
  return "OK        ";
}

let minSeen = Infinity;
let maxSeen = -Infinity;

let stopping = false;
function shutdown(): void {
  if (stopping) return;
  stopping = true;
  process.stdout.write("\n");
  console.log(`session extremes: min=${minSeen} max=${maxSeen}  span=${maxSeen - minSeen} counts (${(((maxSeen - minSeen) / 4096) * 360).toFixed(1)}° of 360°)`);
  close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function main(): void {
  try {
    open();
  } catch (err: any) {
    console.error(`Failed to open ${I2C_BUS}: ${err.message}`);
    process.exit(1);
  }

  console.log("Polling AS5600 every 100 ms. Slowly sweep the shaft through its full range.");
  console.log("Ctrl-C to stop; the session min/max will be printed.");
  console.log("");
  console.log("  raw    angle°     status     AGC   magnitude   session min → max");

  setInterval(() => {
    let raw: number, status: number, agc: number, magnitude: number;
    try {
      const a = readReg(REG_RAW_ANGLE, 2);
      raw = ((a[0] << 8) | a[1]) & 0x0fff;
      status = readReg(REG_STATUS, 1)[0];
      agc = readReg(REG_AGC, 1)[0];
      const m = readReg(REG_MAGNITUDE, 2);
      magnitude = ((m[0] << 8) | m[1]) & 0x0fff;
    } catch (err: any) {
      process.stdout.write(`\rread error: ${err.message}                                 `);
      return;
    }

    if (raw < minSeen) minSeen = raw;
    if (raw > maxSeen) maxSeen = raw;

    const deg = (raw / 4096) * 360;
    const line = `  ${String(raw).padStart(4)}   ${deg.toFixed(1).padStart(6)}°   ${magnetLabel(status)}   ${String(agc).padStart(3)}   ${String(magnitude).padStart(4)}        ${String(minSeen).padStart(4)} → ${String(maxSeen).padStart(4)}`;
    process.stdout.write("\r" + line);
  }, POLL_MS);
}

main();
