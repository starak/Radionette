/**
 * GC9A01 240x240 round IPS display driver.
 *
 * 4-wire SPI. Pin map (BCM):
 *   D/C    GPIO 25 (header pin 22)
 *   RESET  GPIO 24 (header pin 18)
 *   CS     GPIO 8  (SPI0 CE0, kernel-managed)
 *   SCLK   GPIO 11 (SPI0)
 *   MOSI   GPIO 10 (SPI0)
 *
 * See DISPLAY_TEST_SPEC.md for wiring and bring-up procedure.
 */

// rpio ships no types — declare a minimal subset of what we use.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const rpio: {
  LOW: number;
  HIGH: number;
  INPUT: number;
  OUTPUT: number;
  PIN_RESET: number;
  PIN_PRESERVE: number;
  init(opts: { mapping?: "gpio" | "physical" }): void;
  open(pin: number, mode: number, init?: number): void;
  write(pin: number, value: number): void;
  close(pin: number, reset?: number): void;
  msleep(ms: number): void;
  usleep(us: number): void;
} = require("rpio");

import * as spiDevice from "spi-device";

// ---------- Constants ----------

export const WIDTH = 240;
export const HEIGHT = 240;

const DEFAULT_DC_PIN = 25;
const DEFAULT_RESET_PIN = 24;

const SPI_BUS = 0;
const SPI_DEVICE = 0; // /dev/spidev0.0 (CE0)

const SPI_CHUNK = 4096; // spi-device per-transfer limit

// GC9A01 commands we care about
const CMD_SLPOUT = 0x11;
const CMD_DISPON = 0x29;
const CMD_CASET = 0x2a;
const CMD_RASET = 0x2b;
const CMD_RAMWR = 0x2c;
const CMD_MADCTL = 0x36;
const CMD_COLMOD = 0x3a;
const CMD_INVON = 0x21;

// ---------- Types ----------

export type InitVariant = "waveshare" | "adafruit";

export interface InitOptions {
  spiHz?: number;
  mode?: 0 | 3;
  initVariant?: InitVariant;
  madctl?: number; // override MADCTL byte
  dcPin?: number;  // BCM number for D/C
  resetPin?: number; // BCM number for RESET
}

// ---------- Module state ----------

let spi: spiDevice.SpiDevice | null = null;
let initialized = false;
let currentOpts: Required<InitOptions> = {
  spiHz: 32_000_000,
  mode: 0,
  initVariant: "waveshare",
  madctl: 0x48,
  dcPin: DEFAULT_DC_PIN,
  resetPin: DEFAULT_RESET_PIN,
};
let rpioOpen = false;

// ---------- Low-level helpers ----------

function usleep(us: number): void {
  // rpio.usleep is microseconds
  rpio.usleep(us);
}

function msleep(ms: number): void {
  rpio.msleep(ms);
}

function spiTransfer(buf: Buffer): Promise<void> {
  if (!spi) throw new Error("SPI not initialized");
  const dev = spi;
  return new Promise((resolve, reject) => {
    const message: spiDevice.SpiMessage = [
      {
        sendBuffer: buf,
        byteLength: buf.length,
        speedHz: currentOpts.spiHz,
      },
    ];
    dev.transfer(message, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

async function spiTransferChunked(buf: Buffer): Promise<void> {
  for (let off = 0; off < buf.length; off += SPI_CHUNK) {
    const end = Math.min(off + SPI_CHUNK, buf.length);
    await spiTransfer(buf.subarray(off, end));
  }
}

async function writeCommand(cmd: number): Promise<void> {
  rpio.write(currentOpts.dcPin, rpio.LOW);
  usleep(2);
  await spiTransfer(Buffer.from([cmd & 0xff]));
}

async function writeData(data: Buffer | number[]): Promise<void> {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  rpio.write(currentOpts.dcPin, rpio.HIGH);
  usleep(2);
  await spiTransferChunked(buf);
}

export async function sendCommand(cmd: number, data?: number[]): Promise<void> {
  await writeCommand(cmd);
  if (data && data.length > 0) {
    await writeData(data);
  }
}

// ---------- Reset ----------

export async function hardwareReset(): Promise<void> {
  rpio.write(currentOpts.resetPin, rpio.HIGH);
  msleep(50);
  rpio.write(currentOpts.resetPin, rpio.LOW);
  msleep(50);
  rpio.write(currentOpts.resetPin, rpio.HIGH);
  msleep(150);
}

// ---------- Init sequences ----------

/**
 * Waveshare reference init sequence for GC9A01.
 * Verbose but proven on most modules.
 */
async function initWaveshare(madctl: number): Promise<void> {
  const c = sendCommand;

  await c(0xef);
  await c(0xeb, [0x14]);

  await c(0xfe);
  await c(0xef);

  await c(0xeb, [0x14]);

  await c(0x84, [0x40]);
  await c(0x85, [0xff]);
  await c(0x86, [0xff]);
  await c(0x87, [0xff]);
  await c(0x88, [0x0a]);
  await c(0x89, [0x21]);
  await c(0x8a, [0x00]);
  await c(0x8b, [0x80]);
  await c(0x8c, [0x01]);
  await c(0x8d, [0x01]);
  await c(0x8e, [0xff]);
  await c(0x8f, [0xff]);

  await c(0xb6, [0x00, 0x00]);

  await c(CMD_MADCTL, [madctl & 0xff]);
  await c(CMD_COLMOD, [0x05]); // 16-bit RGB565

  await c(0x90, [0x08, 0x08, 0x08, 0x08]);
  await c(0xbd, [0x06]);
  await c(0xbc, [0x00]);
  await c(0xff, [0x60, 0x01, 0x04]);
  await c(0xc3, [0x13]);
  await c(0xc4, [0x13]);
  await c(0xc9, [0x22]);
  await c(0xbe, [0x11]);
  await c(0xe1, [0x10, 0x0e]);
  await c(0xdf, [0x21, 0x0c, 0x02]);

  await c(0xf0, [0x45, 0x09, 0x08, 0x08, 0x26, 0x2a]);
  await c(0xf1, [0x43, 0x70, 0x72, 0x36, 0x37, 0x6f]);
  await c(0xf2, [0x45, 0x09, 0x08, 0x08, 0x26, 0x2a]);
  await c(0xf3, [0x43, 0x70, 0x72, 0x36, 0x37, 0x6f]);

  await c(0xed, [0x1b, 0x0b]);
  await c(0xae, [0x77]);
  await c(0xcd, [0x63]);
  await c(0x70, [0x07, 0x07, 0x04, 0x0e, 0x0f, 0x09, 0x07, 0x08, 0x03]);

  await c(0xe8, [0x34]);

  await c(0x62, [
    0x18, 0x0d, 0x71, 0xed, 0x70, 0x70, 0x18, 0x0f, 0x71, 0xef, 0x70, 0x70,
  ]);
  await c(0x63, [
    0x18, 0x11, 0x71, 0xf1, 0x70, 0x70, 0x18, 0x13, 0x71, 0xf3, 0x70, 0x70,
  ]);
  await c(0x64, [0x28, 0x29, 0xf1, 0x01, 0xf1, 0x00, 0x07]);
  await c(0x66, [0x3c, 0x00, 0xcd, 0x67, 0x45, 0x45, 0x10, 0x00, 0x00, 0x00]);
  await c(0x67, [0x00, 0x3c, 0x00, 0x00, 0x00, 0x01, 0x54, 0x10, 0x32, 0x98]);

  await c(0x74, [0x10, 0x85, 0x80, 0x00, 0x00, 0x4e, 0x00]);

  await c(0x98, [0x3e, 0x07]);

  await c(0x35);
  await c(CMD_INVON);

  await c(CMD_SLPOUT);
  msleep(120);

  await c(CMD_DISPON);
  msleep(20);
}

/**
 * Adafruit-style minimal init sequence. Use as a fallback.
 */
async function initAdafruit(madctl: number): Promise<void> {
  const c = sendCommand;

  await c(0xef);
  await c(0xeb, [0x14]);
  await c(0xfe);
  await c(0xef);
  await c(0xeb, [0x14]);
  await c(0x84, [0x40]);
  await c(0x85, [0xff]);
  await c(0x86, [0xff]);
  await c(0x87, [0xff]);
  await c(0x88, [0x0a]);
  await c(0x89, [0x21]);
  await c(0x8a, [0x00]);
  await c(0x8b, [0x80]);
  await c(0x8c, [0x01]);
  await c(0x8d, [0x01]);
  await c(0x8e, [0xff]);
  await c(0x8f, [0xff]);

  await c(0xb6, [0x00, 0x00]);
  await c(CMD_MADCTL, [madctl & 0xff]);
  await c(CMD_COLMOD, [0x05]);
  await c(CMD_INVON);
  await c(CMD_SLPOUT);
  msleep(120);
  await c(CMD_DISPON);
  msleep(20);
}

// ---------- Public API ----------

export async function initDisplay(opts: InitOptions = {}): Promise<void> {
  const next: Required<InitOptions> = {
    spiHz: opts.spiHz ?? 32_000_000,
    mode: opts.mode ?? 0,
    initVariant: opts.initVariant ?? "waveshare",
    madctl: opts.madctl ?? 0x48,
    dcPin: opts.dcPin ?? DEFAULT_DC_PIN,
    resetPin: opts.resetPin ?? DEFAULT_RESET_PIN,
  };

  // If already open with different pins, release the old ones first.
  if (
    rpioOpen &&
    (next.dcPin !== currentOpts.dcPin || next.resetPin !== currentOpts.resetPin)
  ) {
    try {
      rpio.write(currentOpts.resetPin, rpio.HIGH);
      rpio.write(currentOpts.dcPin, rpio.HIGH);
      rpio.close(currentOpts.dcPin, rpio.PIN_PRESERVE);
      rpio.close(currentOpts.resetPin, rpio.PIN_PRESERVE);
    } catch {
      /* ignore */
    }
    rpioOpen = false;
  }

  currentOpts = next;

  if (!rpioOpen) {
    rpio.init({ mapping: "gpio" });
    rpio.open(currentOpts.dcPin, rpio.OUTPUT, rpio.LOW);
    rpio.open(currentOpts.resetPin, rpio.OUTPUT, rpio.HIGH);
    rpioOpen = true;
  }

  if (spi) {
    await new Promise<void>((res) => spi!.close(() => res()));
    spi = null;
  }

  spi = await new Promise<spiDevice.SpiDevice>((resolve, reject) => {
    const dev = spiDevice.open(SPI_BUS, SPI_DEVICE, (err) => {
      if (err) reject(err);
      else resolve(dev);
    });
  });

  const mode: spiDevice.SpiMode =
    currentOpts.mode === 3 ? 3 : 0;

  await new Promise<void>((resolve, reject) => {
    spi!.setOptions(
      {
        mode,
        maxSpeedHz: currentOpts.spiHz,
        bitsPerWord: 8,
      },
      (err) => (err ? reject(err) : resolve()),
    );
  });

  await hardwareReset();

  if (currentOpts.initVariant === "adafruit") {
    await initAdafruit(currentOpts.madctl);
  } else {
    await initWaveshare(currentOpts.madctl);
  }

  initialized = true;
}

function ensureReady(): void {
  if (!initialized || !spi) {
    throw new Error("Display not initialized. Call initDisplay() first.");
  }
}

async function setAddressWindow(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): Promise<void> {
  await sendCommand(CMD_CASET, [
    (x0 >> 8) & 0xff,
    x0 & 0xff,
    (x1 >> 8) & 0xff,
    x1 & 0xff,
  ]);
  await sendCommand(CMD_RASET, [
    (y0 >> 8) & 0xff,
    y0 & 0xff,
    (y1 >> 8) & 0xff,
    y1 & 0xff,
  ]);
  await writeCommand(CMD_RAMWR);
}

export function rgb565(r: number, g: number, b: number): number {
  const rr = (r & 0xff) >> 3;
  const gg = (g & 0xff) >> 2;
  const bb = (b & 0xff) >> 3;
  return ((rr << 11) | (gg << 5) | bb) & 0xffff;
}

export async function fillScreen(
  r: number,
  g: number,
  b: number,
): Promise<void> {
  ensureReady();
  const px = rgb565(r, g, b);
  const hi = (px >> 8) & 0xff;
  const lo = px & 0xff;

  // Build one row, then send 240 rows. Avoids a 115 KB allocation
  // for very large fills while still keeping SPI bursts large.
  const rowBytes = WIDTH * 2;
  const row = Buffer.alloc(rowBytes);
  for (let i = 0; i < WIDTH; i++) {
    row[i * 2] = hi;
    row[i * 2 + 1] = lo;
  }

  await setAddressWindow(0, 0, WIDTH - 1, HEIGHT - 1);
  rpio.write(currentOpts.dcPin, rpio.HIGH);
  usleep(2);
  for (let y = 0; y < HEIGHT; y++) {
    await spiTransferChunked(row);
  }
}

export async function drawRgb565Buffer(buf: Buffer): Promise<void> {
  ensureReady();
  const expected = WIDTH * HEIGHT * 2;
  if (buf.length !== expected) {
    throw new Error(
      `drawRgb565Buffer: expected ${expected} bytes, got ${buf.length}`,
    );
  }
  await setAddressWindow(0, 0, WIDTH - 1, HEIGHT - 1);
  await writeData(buf);
}

export async function testPattern(): Promise<void> {
  ensureReady();
  const buf = Buffer.alloc(WIDTH * HEIGHT * 2);
  const bars: Array<[number, number, number]> = [
    [255, 0, 0],
    [0, 255, 0],
    [0, 0, 255],
    [255, 255, 255],
  ];
  const barH = HEIGHT / bars.length;
  for (let y = 0; y < HEIGHT; y++) {
    const [r, g, b] = bars[Math.min(bars.length - 1, Math.floor(y / barH))];
    const px = rgb565(r, g, b);
    const hi = (px >> 8) & 0xff;
    const lo = px & 0xff;
    for (let x = 0; x < WIDTH; x++) {
      const i = (y * WIDTH + x) * 2;
      buf[i] = hi;
      buf[i + 1] = lo;
    }
  }
  await drawRgb565Buffer(buf);
}

export async function checkerboard(squareSize = 16): Promise<void> {
  ensureReady();
  const buf = Buffer.alloc(WIDTH * HEIGHT * 2);
  const a = rgb565(0, 0, 0);
  const b = rgb565(255, 255, 255);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const isA =
        (Math.floor(x / squareSize) + Math.floor(y / squareSize)) % 2 === 0;
      const px = isA ? a : b;
      const i = (y * WIDTH + x) * 2;
      buf[i] = (px >> 8) & 0xff;
      buf[i + 1] = px & 0xff;
    }
  }
  await drawRgb565Buffer(buf);
}

/**
 * Continuously stream NOPs over SPI for `seconds`.
 * Useful for scoping SCLK at the display end.
 */
export async function stress(seconds = 10): Promise<void> {
  ensureReady();
  const chunk = Buffer.alloc(SPI_CHUNK, 0x00);
  const end = Date.now() + seconds * 1000;
  rpio.write(currentOpts.dcPin, rpio.HIGH);
  while (Date.now() < end) {
    await spiTransfer(chunk);
  }
}

export async function stopDisplay(): Promise<void> {
  if (spi) {
    await new Promise<void>((res) => spi!.close(() => res()));
    spi = null;
  }
  if (rpioOpen) {
    try {
      // Drive RESET high and leave it high so the panel stays out of
      // reset after the process exits. Same for D/C — leaving it as a
      // driven output avoids it floating into the panel during shutdown.
      rpio.write(currentOpts.resetPin, rpio.HIGH);
      rpio.write(currentOpts.dcPin, rpio.HIGH);
      rpio.close(currentOpts.dcPin, rpio.PIN_PRESERVE);
      rpio.close(currentOpts.resetPin, rpio.PIN_PRESERVE);
    } catch {
      /* ignore */
    }
    rpioOpen = false;
  }
  initialized = false;
}

export function getOptions(): Readonly<Required<InitOptions>> {
  return currentOpts;
}
