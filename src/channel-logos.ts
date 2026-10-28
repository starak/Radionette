import * as fs from "fs";
import * as path from "path";
import { radionetteConfigDir } from "./config-storage";

const MAX_LOGO_BYTES = 4_000_000;

export function customLogoDir(): string {
  return path.join(radionetteConfigDir(), "channel-logos");
}

export function customLogoPath(filename: string): string | null {
  if (!filename || path.basename(filename) !== filename) return null;
  const filePath = path.join(customLogoDir(), filename);
  return fs.existsSync(filePath) ? filePath : null;
}

function imageExtension(bytes: Buffer): "png" | "gif" | "jpg" | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "png";
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString("ascii"))) return "gif";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  return null;
}

function validateImage(bytes: Buffer): "png" | "gif" | "jpg" {
  if (bytes.length === 0 || bytes.length > MAX_LOGO_BYTES) {
    throw new Error("Logo must be between 1 byte and 4 MB");
  }
  const extension = imageExtension(bytes);
  if (!extension) throw new Error("Logo must be a PNG, JPEG, or GIF image");
  return extension;
}

function safeId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "station";
}

export function saveUploadedLogo(channelId: unknown, base64: unknown): string {
  if (typeof channelId !== "string" || !channelId.trim()) throw new Error("Station ID is required");
  if (typeof base64 !== "string" || !base64) throw new Error("Logo data is required");
  let bytes: Buffer;
  try {
    bytes = Buffer.from(base64, "base64");
  } catch {
    throw new Error("Invalid logo encoding");
  }
  const extension = validateImage(bytes);
  const filename = `custom-${safeId(channelId)}-${Date.now()}.${extension}`;
  fs.mkdirSync(customLogoDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(customLogoDir(), filename), bytes, { mode: 0o600 });
  return filename;
}

export function exportCustomLogos(): Record<string, string> {
  const dir = customLogoDir();
  if (!fs.existsSync(dir)) return {};
  const result: Record<string, string> = {};
  for (const filename of fs.readdirSync(dir)) {
    const filePath = customLogoPath(filename);
    if (!filePath) continue;
    const bytes = fs.readFileSync(filePath);
    if (!imageExtension(bytes) || bytes.length > MAX_LOGO_BYTES) continue;
    result[filename] = bytes.toString("base64");
  }
  return result;
}

export function validateCustomLogosBackup(value: unknown): Record<string, Buffer> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("customLogos must be an object");
  }
  const result: Record<string, Buffer> = {};
  for (const [filename, encoded] of Object.entries(value)) {
    if (path.basename(filename) !== filename || !/^custom-[a-z0-9_-]+-\d+\.(png|gif|jpg)$/.test(filename)) {
      throw new Error(`Invalid custom logo filename: ${filename}`);
    }
    if (typeof encoded !== "string") throw new Error(`Invalid custom logo data: ${filename}`);
    const bytes = Buffer.from(encoded, "base64");
    const extension = validateImage(bytes);
    if (!filename.endsWith(`.${extension}`)) throw new Error(`Custom logo type mismatch: ${filename}`);
    result[filename] = bytes;
  }
  return result;
}

export function importCustomLogos(logos: Record<string, Buffer>): void {
  if (Object.keys(logos).length === 0) return;
  fs.mkdirSync(customLogoDir(), { recursive: true, mode: 0o700 });
  for (const [filename, bytes] of Object.entries(logos)) {
    fs.writeFileSync(path.join(customLogoDir(), filename), bytes, { mode: 0o600 });
  }
}
