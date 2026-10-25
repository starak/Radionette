import { radionetteConfigPath, readJsonFile, writeJsonAtomic } from "./config-storage";

interface SpotifySecretSettings {
  apiKey: string;
  bandOrdinal: number;
}

const FILE_PATH = radionetteConfigPath("spotify.json");
let cachedSettings: Partial<SpotifySecretSettings> | null = null;

export interface SpotifySettingsStatus {
  configured: boolean;
  provider: "soloist";
  bandOrdinal: number;
}

function readSettings(): Partial<SpotifySecretSettings> {
  if (cachedSettings === null) {
    cachedSettings = readJsonFile<Partial<SpotifySecretSettings>>(FILE_PATH) || {};
  }
  return cachedSettings;
}

function writeSettings(value: Partial<SpotifySecretSettings>): void {
  writeJsonAtomic(FILE_PATH, value);
  cachedSettings = value;
}

export function getSpotifyApiKey(): string | null {
  try {
    const value = readSettings();
    return typeof value?.apiKey === "string" && value.apiKey.trim()
      ? value.apiKey.trim()
      : null;
  } catch (err) {
    console.error("[Spotify] Could not read private settings:", err);
    return null;
  }
}

export function getSpotifyBandOrdinal(): number {
  try {
    const value = readSettings().bandOrdinal;
    return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 4;
  } catch {
    return 4;
  }
}

export function getSpotifySettingsStatus(): SpotifySettingsStatus {
  return {
    configured: getSpotifyApiKey() !== null,
    provider: "soloist",
    bandOrdinal: getSpotifyBandOrdinal(),
  };
}

export function saveSpotifyApiKey(value: unknown): SpotifySettingsStatus {
  if (typeof value !== "string") throw new Error("Spotify Soloist API key is required");
  const apiKey = value.trim();
  if (apiKey.length < 20 || apiKey.length > 4096) {
    throw new Error("Enter a valid Spotify Soloist API key");
  }
  writeSettings({ ...readSettings(), apiKey });
  console.log("[Spotify] Soloist API key saved");
  return getSpotifySettingsStatus();
}

export function clearSpotifyApiKey(): SpotifySettingsStatus {
  const { apiKey: _removed, ...remaining } = readSettings();
  writeSettings(remaining);
  console.log("[Spotify] Soloist API key cleared");
  return getSpotifySettingsStatus();
}

export function saveSpotifyBandOrdinal(value: unknown): SpotifySettingsStatus {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new Error("Spotify band must be a positive band ordinal");
  }
  writeSettings({ ...readSettings(), bandOrdinal: value as number });
  console.log(`[Spotify] Assigned to logical Band ${value}`);
  return getSpotifySettingsStatus();
}
