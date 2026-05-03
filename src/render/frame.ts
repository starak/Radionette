/**
 * Pixel-format helpers for the GC9A01 240x240 panel.
 *
 * The driver in src/display.ts expects a 115200-byte (240*240*2) buffer of
 * RGB565 big-endian pixels via drawRgb565Buffer().
 *
 * Colour tint:
 *   The GC9A01 has a noticeably cool/blue native white point. We warm it up
 *   in software by multiplying R/G/B by per-channel gains during the RGBA ->
 *   RGB565 conversion. Tint is baked into the cached frames in logos.ts, so
 *   call clearLogoCache() after changing it.
 */

export const WIDTH = 240;
export const HEIGHT = 240;
export const PIXELS = WIDTH * HEIGHT;
export const FRAME_BYTES = PIXELS * 2;

export interface Tint {
  r: number; // multiplier, typically 0.5..1.5
  g: number;
  b: number;
}

// Default warm tint. This is a retro radio — push hard toward incandescent /
// candle-flame warmth (~3000 K and below). Tweak via setTint() at runtime.
const DEFAULT_TINT: Tint = { r: 1.1, g: 0.75, b: 0.5 };

let tint: Tint = { ...DEFAULT_TINT };

// Pre-built lookup tables so the hot loop is just three memory reads instead
// of a multiply + clamp per pixel. Rebuilt whenever tint changes.
let lutR = new Uint8Array(256);
let lutG = new Uint8Array(256);
let lutB = new Uint8Array(256);

function buildLuts(): void {
  for (let i = 0; i < 256; i++) {
    lutR[i] = Math.min(255, Math.max(0, Math.round(i * tint.r)));
    lutG[i] = Math.min(255, Math.max(0, Math.round(i * tint.g)));
    lutB[i] = Math.min(255, Math.max(0, Math.round(i * tint.b)));
  }
}
buildLuts();

export function setTint(next: Partial<Tint>): void {
  tint = {
    r: next.r ?? tint.r,
    g: next.g ?? tint.g,
    b: next.b ?? tint.b,
  };
  buildLuts();
}

export function getTint(): Readonly<Tint> {
  return { ...tint };
}

export function getDefaultTint(): Readonly<Tint> {
  return { ...DEFAULT_TINT };
}

/**
 * Convert an RGBA8888 buffer (4 bytes/pixel, top-left origin, row-major) of
 * exactly WIDTH*HEIGHT pixels to an RGB565 big-endian Buffer ready for the
 * GC9A01.
 *
 * Alpha is ignored (the panel is opaque). Source dimensions must match the
 * panel — caller is responsible for resizing/cropping beforehand.
 *
 * Per-channel tint LUT is applied here.
 */
export function rgba8888ToRgb565(rgba: Uint8ClampedArray | Buffer): Buffer {
  if (rgba.length !== PIXELS * 4) {
    throw new Error(
      `rgba8888ToRgb565: expected ${PIXELS * 4} bytes, got ${rgba.length}`,
    );
  }
  const out = Buffer.allocUnsafe(FRAME_BYTES);
  const lr = lutR, lg = lutG, lb = lutB;
  let si = 0;
  let di = 0;
  for (let i = 0; i < PIXELS; i++) {
    const r = lr[rgba[si]];
    const g = lg[rgba[si + 1]];
    const b = lb[rgba[si + 2]];
    si += 4;
    const v =
      ((r & 0xf8) << 8) | ((g & 0xfc) << 3) | (b >> 3);
    // Big-endian: high byte first
    out[di++] = (v >> 8) & 0xff;
    out[di++] = v & 0xff;
  }
  return out;
}

/**
 * Build a solid-colour RGB565 frame. Useful for fallbacks before any logo
 * is loaded (e.g. boot splash, error state). Tint is applied here too so
 * solid black stays black but white follows the warm tint.
 */
export function solidFrame(r: number, g: number, b: number): Buffer {
  const tr = lutR[r & 0xff];
  const tg = lutG[g & 0xff];
  const tb = lutB[b & 0xff];
  const v =
    ((tr & 0xf8) << 8) | ((tg & 0xfc) << 3) | (tb >> 3);
  const hi = (v >> 8) & 0xff;
  const lo = v & 0xff;
  const out = Buffer.allocUnsafe(FRAME_BYTES);
  for (let i = 0; i < FRAME_BYTES; i += 2) {
    out[i] = hi;
    out[i + 1] = lo;
  }
  return out;
}
