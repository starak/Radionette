/**
 * Pixel-format helpers for the GC9A01 240x240 panel.
 *
 * The driver in src/display.ts expects a 115200-byte (240*240*2) buffer of
 * RGB565 big-endian pixels via drawRgb565Buffer().
 */

export const WIDTH = 240;
export const HEIGHT = 240;
export const PIXELS = WIDTH * HEIGHT;
export const FRAME_BYTES = PIXELS * 2;

/**
 * Convert an RGBA8888 buffer (4 bytes/pixel, top-left origin, row-major) of
 * exactly WIDTH*HEIGHT pixels to an RGB565 big-endian Buffer ready for the
 * GC9A01.
 *
 * Alpha is ignored (the panel is opaque). Source dimensions must match the
 * panel — caller is responsible for resizing/cropping beforehand.
 */
export function rgba8888ToRgb565(rgba: Uint8ClampedArray | Buffer): Buffer {
  if (rgba.length !== PIXELS * 4) {
    throw new Error(
      `rgba8888ToRgb565: expected ${PIXELS * 4} bytes, got ${rgba.length}`,
    );
  }
  const out = Buffer.allocUnsafe(FRAME_BYTES);
  let si = 0;
  let di = 0;
  for (let i = 0; i < PIXELS; i++) {
    const r = rgba[si];
    const g = rgba[si + 1];
    const b = rgba[si + 2];
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
 * is loaded (e.g. boot splash, error state).
 */
export function solidFrame(r: number, g: number, b: number): Buffer {
  const v =
    ((r & 0xf8) << 8) | ((g & 0xfc) << 3) | (b >> 3);
  const hi = (v >> 8) & 0xff;
  const lo = v & 0xff;
  const out = Buffer.allocUnsafe(FRAME_BYTES);
  for (let i = 0; i < FRAME_BYTES; i += 2) {
    out[i] = hi;
    out[i + 1] = lo;
  }
  return out;
}
