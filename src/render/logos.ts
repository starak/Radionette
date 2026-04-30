/**
 * Logo loading and caching for the GC9A01 round display.
 *
 * Pipeline (per logo):
 *   1. Read file from disk (PNG or GIF).
 *   2. Decode to RGBA frames at native size.
 *      - PNG: node-canvas loadImage().
 *      - GIF: gifuct-js parseGIF + decompressFrames, composited frame-by-frame
 *             onto a persistent canvas honouring disposal/transparency.
 *   3. For each frame: render onto a 240x240 canvas, "contain"-fit, centred,
 *      with circular mask (black outside the circle so corners stay dark on
 *      the round panel).
 *   4. Convert each frame to RGB565 big-endian Buffer.
 *
 * Result is a RenderedLogo: one or more frames, each with its display delay
 * in ms (single-frame for static images).
 *
 * Caching: by absolute file path. Files are assumed immutable for the
 * lifetime of the process.
 */

import * as fs from "fs";
import * as path from "path";
import { rgba8888ToRgb565, solidFrame, WIDTH, HEIGHT } from "./frame";

// canvas is declared as an optionalDependency — on the Mac dev box it may not
// be installed. Require it lazily so just importing this module from places
// that don't actually render (e.g. the web UI) doesn't crash.
type CanvasModule = typeof import("canvas");
let _canvas: CanvasModule | null = null;
function canvas(): CanvasModule {
  if (_canvas) return _canvas;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    _canvas = require("canvas") as CanvasModule;
  } catch (err) {
    throw new Error(
      "node-canvas is not installed. On the Pi this is provided via " +
        "optionalDependencies; on macOS install Homebrew prerequisites first " +
        "(pkg-config cairo pango libpng jpeg giflib librsvg) and re-run " +
        "`npm install canvas`. Original error: " +
        (err as Error).message,
    );
  }
  return _canvas;
}

export interface RenderedFrame {
  /** RGB565 big-endian, length = WIDTH*HEIGHT*2 = 115200 */
  rgb565: Buffer;
  /** ms to keep this frame on screen before advancing (>=20). */
  delayMs: number;
}

export interface RenderedLogo {
  /** Source path used as cache key. */
  source: string;
  frames: RenderedFrame[];
  /** True if the source had >1 frame (animated GIF). */
  animated: boolean;
}

export interface LogoLoaderOptions {
  /** Directory holding logo files. Logo references in channels.json are resolved relative to this. */
  logoDir: string;
  /** Optional override for the fallback logo filename (default "default.png"). */
  defaultLogo?: string;
}

const cache = new Map<string, RenderedLogo>();
let opts: LogoLoaderOptions = { logoDir: "" };

export function configureLogos(o: LogoLoaderOptions): void {
  opts = { defaultLogo: "default.png", ...o };
}

/**
 * Resolve a logo reference from channels.json (e.g. "NRK-P1.png") to an
 * absolute path under the configured logoDir. Returns null if the file
 * doesn't exist.
 */
export function resolveLogoPath(ref: string | undefined | null): string | null {
  if (!ref) return null;
  const abs = path.isAbsolute(ref) ? ref : path.join(opts.logoDir, ref);
  return fs.existsSync(abs) ? abs : null;
}

/**
 * Load and cache a logo. Returns the rendered RGB565 frame(s).
 *
 * If `ref` resolves to a missing file, falls back to `defaultLogo`. If THAT
 * is also missing, returns a solid black single-frame logo so callers always
 * get something paintable.
 */
export async function loadLogo(ref: string | undefined | null): Promise<RenderedLogo> {
  let abs = resolveLogoPath(ref);
  if (!abs) {
    abs = resolveLogoPath(opts.defaultLogo);
  }
  if (!abs) {
    // Last-ditch: synthesize a black frame so the controller never crashes.
    return {
      source: "<black>",
      frames: [{ rgb565: solidFrame(0, 0, 0), delayMs: Infinity }],
      animated: false,
    };
  }

  const cached = cache.get(abs);
  if (cached) return cached;

  const ext = path.extname(abs).toLowerCase();
  let logo: RenderedLogo;
  try {
    if (ext === ".gif") {
      logo = await renderGif(abs);
    } else {
      logo = await renderStill(abs);
    }
  } catch (err) {
    console.error(`[Logos] Failed to render ${abs}:`, err);
    logo = {
      source: abs,
      frames: [{ rgb565: solidFrame(0, 0, 0), delayMs: Infinity }],
      animated: false,
    };
  }
  cache.set(abs, logo);
  return logo;
}

/** Drop all cached logos (e.g. for a debug "reload assets" path). */
export function clearLogoCache(): void {
  cache.clear();
}

// ---------- internals ----------

/**
 * Build a fresh 240x240 canvas pre-filled with black, with a circular clip
 * region installed. Anything drawn after returning will be masked to the
 * round panel area; pixels outside the circle stay black.
 */
function makeRoundCanvas(): {
  canvas: import("canvas").Canvas;
  ctx: import("canvas").CanvasRenderingContext2D;
} {
  const { createCanvas } = canvas();
  const c = createCanvas(WIDTH, HEIGHT);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  ctx.save();
  ctx.beginPath();
  ctx.arc(WIDTH / 2, HEIGHT / 2, WIDTH / 2, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  return { canvas: c, ctx };
}

/** "contain"-fit src into the 240x240 round area, centred. */
function drawContained(
  ctx: import("canvas").CanvasRenderingContext2D,
  img: import("canvas").Image | import("canvas").Canvas,
  srcW: number,
  srcH: number,
): void {
  const scale = Math.min(WIDTH / srcW, HEIGHT / srcH);
  const w = srcW * scale;
  const h = srcH * scale;
  const x = (WIDTH - w) / 2;
  const y = (HEIGHT - h) / 2;
  ctx.drawImage(img as any, x, y, w, h);
}

async function renderStill(absPath: string): Promise<RenderedLogo> {
  const { loadImage } = canvas();
  const img = await loadImage(absPath);
  const { canvas: c, ctx } = makeRoundCanvas();
  drawContained(ctx, img, img.width, img.height);
  ctx.restore();
  const rgba = ctx.getImageData(0, 0, WIDTH, HEIGHT).data;
  return {
    source: absPath,
    frames: [{ rgb565: rgba8888ToRgb565(rgba), delayMs: Infinity }],
    animated: false,
  };
}

async function renderGif(absPath: string): Promise<RenderedLogo> {
  // Lazy require so machines without gifuct-js installed don't choke at import time.
  // (gifuct-js is in regular dependencies so this always succeeds in practice.)
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const gifuct = require("gifuct-js") as typeof import("gifuct-js");
  const { createCanvas, createImageData } = canvas();

  const buf = await fs.promises.readFile(absPath);
  // gifuct-js wants an ArrayBuffer. node Buffer is a Uint8Array view; slice
  // to a fresh ArrayBuffer to be safe across Node versions.
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  const gif = gifuct.parseGIF(ab);
  const frames = gifuct.decompressFrames(gif, true);
  if (frames.length === 0) {
    throw new Error("GIF has no frames");
  }

  const fullW = gif.lsd.width;
  const fullH = gif.lsd.height;

  // Persistent compositor: holds the running GIF image at native resolution,
  // honouring disposal between frames.
  const fullC = createCanvas(fullW, fullH);
  const fullCtx = fullC.getContext("2d");

  // Per-frame patch surface (fast path: write patch RGBA via ImageData).
  const patchC = createCanvas(1, 1);
  const patchCtx = patchC.getContext("2d");

  const out: RenderedFrame[] = [];
  let prevDispose = 0;
  let prevX = 0;
  let prevY = 0;
  let prevW = 0;
  let prevH = 0;
  let savedImage: import("canvas").ImageData | null = null;

  for (const f of frames) {
    // Apply previous-frame disposal first.
    if (prevDispose === 2) {
      // Restore to background (transparent / black on our surface).
      fullCtx.clearRect(prevX, prevY, prevW, prevH);
    } else if (prevDispose === 3 && savedImage) {
      fullCtx.putImageData(savedImage, prevX, prevY);
    }
    if (f.disposalType === 3) {
      savedImage = fullCtx.getImageData(
        f.dims.left,
        f.dims.top,
        f.dims.width,
        f.dims.height,
      );
    }

    // Paint the patch.
    patchC.width = f.dims.width;
    patchC.height = f.dims.height;
    const imgData = createImageData(
      new Uint8ClampedArray(f.patch),
      f.dims.width,
      f.dims.height,
    );
    patchCtx.putImageData(imgData, 0, 0);
    fullCtx.drawImage(patchC, f.dims.left, f.dims.top);

    prevDispose = f.disposalType;
    prevX = f.dims.left;
    prevY = f.dims.top;
    prevW = f.dims.width;
    prevH = f.dims.height;

    // Compose the current full GIF state onto the round 240 canvas.
    const { canvas: rc, ctx: rctx } = makeRoundCanvas();
    drawContained(rctx, fullC, fullW, fullH);
    rctx.restore();
    const rgba = rctx.getImageData(0, 0, WIDTH, HEIGHT).data;

    // gifuct-js delay is in *centiseconds*; clamp to a sane minimum so a
    // 0-delay frame (some encoders) doesn't peg the SPI bus.
    const delayMs = Math.max(20, (f.delay || 10) * 10);
    out.push({ rgb565: rgba8888ToRgb565(rgba), delayMs });
  }

  return {
    source: absPath,
    frames: out,
    animated: out.length > 1,
  };
}
