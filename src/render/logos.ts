/**
 * Logo loading and caching for the 240×240 GC9A01 panel.
 *
 * FFmpeg decodes local PNG/GIF files, remote artwork and generated SVG text
 * logos into RGBA frames. This avoids node-canvas/Cairo native bindings while
 * retaining animated GIF timing through FFmpeg's showinfo timestamps.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawn } from "child_process";
import { rgba8888ToRgb565, solidFrame, WIDTH, HEIGHT } from "./frame";
import { customLogoPath } from "../channel-logos";

export interface RenderedFrame {
  rgb565: Buffer;
  delayMs: number;
}

export interface RenderedLogo {
  source: string;
  frames: RenderedFrame[];
  animated: boolean;
}

export interface LogoLoaderOptions {
  logoDir: string;
  defaultLogo?: string;
}

const FRAME_BYTES_RGBA = WIDTH * HEIGHT * 4;
const MAX_ANIMATION_FRAMES = 300;
const cache = new Map<string, RenderedLogo>();
let opts: LogoLoaderOptions = { logoDir: "" };

export function configureLogos(o: LogoLoaderOptions): void {
  opts = { defaultLogo: "default.png", ...o };
}

export function resolveLogoPath(ref: string | undefined | null): string | null {
  if (!ref) return null;
  if (!path.isAbsolute(ref)) {
    const custom = customLogoPath(ref);
    if (custom) return custom;
  }
  const abs = path.isAbsolute(ref) ? ref : path.join(opts.logoDir, ref);
  return fs.existsSync(abs) ? abs : null;
}

export async function loadLogo(ref: string | undefined | null): Promise<RenderedLogo> {
  if (typeof ref === "string" && /^text:/i.test(ref)) {
    const cached = cache.get(ref);
    if (cached) return cached;
    try {
      const logo = await renderTextLogo(ref);
      cache.set(ref, logo);
      return logo;
    } catch (err) {
      console.error(`[Logos] Failed to render text logo ${ref}:`, err);
    }
  }

  if (typeof ref === "string" && /^https?:\/\//i.test(ref)) {
    const cached = cache.get(ref);
    if (cached) return cached;
    try {
      const logo = await renderRemote(ref);
      cache.set(ref, logo);
      return logo;
    } catch (err) {
      console.error(`[Logos] Failed to fetch/render ${ref}:`, err);
    }
  }

  let abs = resolveLogoPath(ref);
  if (!abs) abs = resolveLogoPath(opts.defaultLogo);
  if (!abs) return blackLogo("<black>");
  const cached = cache.get(abs);
  if (cached) return cached;

  try {
    const animated = path.extname(abs).toLowerCase() === ".gif";
    const logo = await renderFile(abs, abs, animated);
    cache.set(abs, logo);
    return logo;
  } catch (err) {
    console.error(`[Logos] Failed to render ${abs}:`, err);
    const logo = blackLogo(abs);
    cache.set(abs, logo);
    return logo;
  }
}

export function clearLogoCache(): void {
  cache.clear();
}

function blackLogo(source: string): RenderedLogo {
  return {
    source,
    frames: [{ rgb565: solidFrame(0, 0, 0), delayMs: Infinity }],
    animated: false,
  };
}

async function renderRemote(url: string): Promise<RenderedLogo> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  let bytes: Buffer;
  try {
    const response = await fetch(url, { signal: ac.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
  return withTempFile("artwork.img", bytes, (file) => renderFile(file, url, false));
}

async function renderTextLogo(ref: string): Promise<RenderedLogo> {
  const rest = ref.slice("text:".length);
  const pipe = rest.indexOf("|");
  const id = pipe >= 0 ? rest.slice(0, pipe) : rest;
  const displayName = pipe >= 0 ? rest.slice(pipe + 1) : rest;
  const label = (displayName || id || "?").trim() || "?";
  const lines = wrapText(label, 9);
  const fontSize = chooseFontSize(lines);
  const lineHeight = Math.round(fontSize * 1.18);
  const totalHeight = lineHeight * lines.length;
  const firstY = HEIGHT / 2 - totalHeight / 2 + lineHeight / 2;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <rect width="${WIDTH}" height="${HEIGHT}" fill="#000000"/>
  <g font-family="DejaVu Sans, sans-serif" font-weight="700" font-size="${fontSize}" fill="#ffffff" text-anchor="middle">
${lines.map((line, i) => `    <text x="${WIDTH / 2}" y="${firstY + i * lineHeight}" dominant-baseline="middle">${escapeXml(line)}</text>`).join("\n")}
  </g>
</svg>`;
  return withTempFile("text-logo.svg", Buffer.from(svg), (file) => renderFile(file, ref, false));
}

async function withTempFile<T>(filename: string, bytes: Buffer, fn: (file: string) => Promise<T>): Promise<T> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "radionette-logo-"));
  const file = path.join(dir, filename);
  try {
    await fs.promises.writeFile(file, bytes);
    return await fn(file);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function renderFile(inputPath: string, source: string, animated: boolean): Promise<RenderedLogo> {
  return new Promise((resolve, reject) => {
    const showInfo = animated ? ",showinfo" : "";
    const filter = `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=black,format=rgba${showInfo}`;
    const args = [
      "-hide_banner", "-nostdin", "-loglevel", animated ? "info" : "error",
      "-i", inputPath,
      "-vf", filter,
      "-frames:v", animated ? String(MAX_ANIMATION_FRAMES) : "1",
      "-fps_mode", "passthrough",
      "-pix_fmt", "rgba", "-f", "rawvideo", "pipe:1",
    ];
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    let stderr = "";
    let outputBytes = 0;
    const timeout = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes <= FRAME_BYTES_RGBA * MAX_ANIMATION_FRAMES) stdout.push(chunk);
      else child.kill("SIGKILL");
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", (err) => { clearTimeout(timeout); reject(err); });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-1000)}`));
        return;
      }
      const raw = Buffer.concat(stdout);
      const count = Math.floor(raw.length / FRAME_BYTES_RGBA);
      if (count < 1) {
        reject(new Error("ffmpeg returned no video frames"));
        return;
      }
      const timestamps = Array.from(stderr.matchAll(/pts_time:([0-9.+-]+)/g), (match) => Number(match[1])).filter(Number.isFinite);
      const frames: RenderedFrame[] = [];
      for (let i = 0; i < count; i++) {
        let delayMs = Infinity;
        if (count > 1) {
          const delta = i + 1 < timestamps.length ? (timestamps[i + 1] - timestamps[i]) * 1000 : NaN;
          const previous = i > 0 ? frames[i - 1].delayMs : 100;
          delayMs = Number.isFinite(delta) && delta > 0 ? Math.max(20, Math.round(delta)) : previous;
        }
        const rgba = raw.subarray(i * FRAME_BYTES_RGBA, (i + 1) * FRAME_BYTES_RGBA);
        frames.push({ rgb565: rgba8888ToRgb565(rgba), delayMs });
      }
      resolve({ source, frames, animated: frames.length > 1 });
    });
  });
}

function wrapText(label: string, target: number): string[] {
  const words = label.split(/\s+/).filter(Boolean);
  if (words.length <= 1) return [label];
  const lines: string[] = [];
  let current = words[0];
  for (let i = 1; i < words.length; i++) {
    const next = `${current} ${words[i]}`;
    if (next.length <= target || lines.length === 2) current = next;
    else { lines.push(current); current = words[i]; }
    if (lines.length === 2) { current = [current, ...words.slice(i + 1)].join(" "); break; }
  }
  lines.push(current);
  return lines.slice(0, 3);
}

function chooseFontSize(lines: string[]): number {
  const longest = Math.max(...lines.map((line) => line.length));
  const lineLimit = lines.length >= 3 ? 25 : lines.length === 2 ? 34 : 46;
  return Math.max(18, Math.min(lineLimit, Math.floor(190 / Math.max(1, longest) * 1.7)));
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
