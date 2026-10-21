import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export function radionetteConfigDir(): string {
  return process.env.RADIONETTE_CONFIG_DIR || path.join(os.homedir(), ".radionette");
}

export function radionetteConfigPath(filename: string): string {
  return path.join(radionetteConfigDir(), filename);
}

/** Write JSON without ever exposing a half-written configuration file. */
export function writeJsonAtomic(filePath: string, value: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const backupPath = `${filePath}.bak`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf-8",
    mode: 0o600,
  });
  try {
    if (fs.existsSync(filePath)) fs.copyFileSync(filePath, backupPath);
    fs.renameSync(tempPath, filePath);
  } catch (err) {
    try { fs.unlinkSync(tempPath); } catch { /* ignore cleanup failure */ }
    throw err;
  }
}

export function readJsonFile<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
}

export function removeJsonFileWithBackup(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  fs.copyFileSync(filePath, `${filePath}.bak`);
  fs.unlinkSync(filePath);
}
