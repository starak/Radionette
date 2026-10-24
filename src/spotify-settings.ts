import { radionetteConfigPath, readJsonFile, writeJsonAtomic } from "./config-storage";

interface SpotifySecretSettings {
  apiKey: string;
}

const FILE_PATH = radionetteConfigPath("spotify.json");

export interface SpotifySettingsStatus {
  configured: boolean;
  provider: "soloist";
}

export function getSpotifyApiKey(): string | null {
  try {
    const value = readJsonFile<Partial<SpotifySecretSettings>>(FILE_PATH);
    return typeof value?.apiKey === "string" && value.apiKey.trim()
      ? value.apiKey.trim()
      : null;
  } catch (err) {
    console.error("[Spotify] Could not read private settings:", err);
    return null;
  }
}

export function getSpotifySettingsStatus(): SpotifySettingsStatus {
  return { configured: getSpotifyApiKey() !== null, provider: "soloist" };
}

export function saveSpotifyApiKey(value: unknown): SpotifySettingsStatus {
  if (typeof value !== "string") throw new Error("Spotify Soloist API key is required");
  const apiKey = value.trim();
  if (apiKey.length < 20 || apiKey.length > 4096) {
    throw new Error("Enter a valid Spotify Soloist API key");
  }
  writeJsonAtomic(FILE_PATH, { apiKey });
  console.log("[Spotify] Soloist API key saved");
  return getSpotifySettingsStatus();
}
