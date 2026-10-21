import * as crypto from "crypto";
import { radionetteConfigPath, readJsonFile, writeJsonAtomic } from "./config-storage";

interface SecurityFile {
  salt: string;
  hash: string;
}

const DEFAULT_PIN = "1972";
const FILE_PATH = radionetteConfigPath("security.json");
const SESSION_MS = 8 * 60 * 60 * 1000;

let saved: SecurityFile | null = null;
const sessions = new Map<string, number>();

function hashPin(pin: string, salt: Buffer): Buffer {
  return crypto.scryptSync(pin, salt, 32);
}

function equalBuffers(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function loadSettingsSecurity(): void {
  try {
    const value = readJsonFile<SecurityFile>(FILE_PATH);
    if (!value) {
      saved = null;
      console.warn("[SettingsSecurity] Using the default settings PIN; change it from /settings");
      return;
    }
    if (typeof value.salt !== "string" || typeof value.hash !== "string") {
      throw new Error("invalid security file");
    }
    saved = value;
    console.log(`[SettingsSecurity] Loaded settings PIN from ${FILE_PATH}`);
  } catch (err) {
    saved = null;
    console.error(`[SettingsSecurity] Failed to load ${FILE_PATH}; using default PIN:`, err);
  }
}

export function validatePinFormat(pin: unknown): string {
  if (typeof pin !== "string" || !/^\d{4,12}$/.test(pin)) {
    throw new Error("PIN must contain 4 to 12 digits");
  }
  return pin;
}

export function verifySettingsPin(pin: unknown): boolean {
  if (typeof pin !== "string") return false;
  if (!saved) {
    return equalBuffers(
      Buffer.from(crypto.createHash("sha256").update(pin).digest()),
      Buffer.from(crypto.createHash("sha256").update(DEFAULT_PIN).digest()),
    );
  }
  try {
    return equalBuffers(
      hashPin(pin, Buffer.from(saved.salt, "hex")),
      Buffer.from(saved.hash, "hex"),
    );
  } catch {
    return false;
  }
}

export function changeSettingsPin(currentPin: unknown, newPin: unknown): void {
  if (!verifySettingsPin(currentPin)) throw new Error("Current PIN is incorrect");
  const validated = validatePinFormat(newPin);
  const salt = crypto.randomBytes(16);
  const next: SecurityFile = {
    salt: salt.toString("hex"),
    hash: hashPin(validated, salt).toString("hex"),
  };
  writeJsonAtomic(FILE_PATH, next);
  saved = next;
  sessions.clear();
}

export function createSettingsSession(): string {
  const token = crypto.randomBytes(32).toString("base64url");
  sessions.set(token, Date.now() + SESSION_MS);
  return token;
}

export function verifySettingsSession(token: string | undefined): boolean {
  if (!token) return false;
  const expires = sessions.get(token);
  if (!expires) return false;
  if (expires <= Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

export function deleteSettingsSession(token: string | undefined): void {
  if (token) sessions.delete(token);
}

export function settingsSessionMaxAgeSeconds(): number {
  return Math.floor(SESSION_MS / 1000);
}
