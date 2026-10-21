import * as fs from "fs";
import { radionetteConfigPath, removeJsonFileWithBackup, writeJsonAtomic } from "./config-storage";

export type DisplayMode =
  | "auto-artwork"
  | "auto-logo"
  | "always-artwork"
  | "always-logo"
  | "off";

export type BacklightPolicy = "auto" | "always-on" | "off";

export interface DisplaySetting {
  mode: DisplayMode;
  bits: number;
  mapped: boolean;
  label: string;
  albumArt: boolean;
  backlight: BacklightPolicy;
}

export interface DisplayMappingFile {
  autoArtwork: number;
  autoLogo: number;
  alwaysArtwork: number;
  alwaysLogo: number;
  off: number;
}

export interface DisplayOption {
  mode: DisplayMode;
  bits: number;
  label: string;
}

const DEFINITIONS: Array<{
  key: keyof DisplayMappingFile;
  mode: DisplayMode;
  label: string;
  albumArt: boolean;
  backlight: BacklightPolicy;
}> = [
  { key: "autoArtwork", mode: "auto-artwork", label: "Auto · logo + artwork", albumArt: true, backlight: "auto" },
  { key: "autoLogo", mode: "auto-logo", label: "Auto · logo only", albumArt: false, backlight: "auto" },
  { key: "alwaysArtwork", mode: "always-artwork", label: "Always on · logo + artwork", albumArt: true, backlight: "always-on" },
  { key: "alwaysLogo", mode: "always-logo", label: "Always on · logo only", albumArt: false, backlight: "always-on" },
  { key: "off", mode: "off", label: "Display off", albumArt: false, backlight: "off" },
];

const FALLBACK: DisplaySetting = {
  mode: "auto-artwork",
  bits: 0,
  mapped: false,
  label: "Normal · logo + artwork (fallback)",
  albumArt: true,
  backlight: "auto",
};

let mapping: DisplayMappingFile | null = null;
let mappingPath: string | null = null;

export function loadDisplayMapping(configPath?: string): void {
  mappingPath =
    configPath ||
    process.env.RADIONETTE_DISPLAY_MAPPING ||
    radionetteConfigPath("display-mapping.json");

  mapping = null;
  if (!fs.existsSync(mappingPath)) {
    console.log(
      `[DisplaySettings] No mapping at ${mappingPath}; all lower-nibble values use normal auto/artwork mode`,
    );
    return;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(mappingPath, "utf-8"));
    mapping = validateDisplayMapping(parsed);
    console.log(
      `[DisplaySettings] Loaded ${mappingPath}: ${getDisplayOptions()
        .map((option) => `${option.mode}=0x${option.bits.toString(16)}`)
        .join(" ")}`,
    );
  } catch (err) {
    console.error(`[DisplaySettings] Invalid mapping ${mappingPath}:`, err);
    console.warn("[DisplaySettings] Falling back to normal auto/artwork mode");
  }
}

export function validateDisplayMapping(value: any): DisplayMappingFile {
  const parsed = value as Partial<DisplayMappingFile>;
  const values = DEFINITIONS.map((definition) => parsed?.[definition.key]);
  if (values.some((entry) => !Number.isInteger(entry) || entry! < 0 || entry! > 15)) {
    throw new Error("every display mapping value must be a whole number from 0 to 15");
  }
  if (new Set(values).size !== values.length) {
    throw new Error("display mapping values must be unique");
  }
  return Object.fromEntries(
    DEFINITIONS.map((definition) => [definition.key, parsed[definition.key]]),
  ) as unknown as DisplayMappingFile;
}

export function saveDisplayMapping(value: unknown): DisplayMappingFile {
  const validated = validateDisplayMapping(value);
  const filePath =
    process.env.RADIONETTE_DISPLAY_MAPPING ||
    radionetteConfigPath("display-mapping.json");
  writeJsonAtomic(filePath, validated);
  mapping = validated;
  mappingPath = filePath;
  return { ...validated };
}

export function getDisplayMapping(): DisplayMappingFile | null {
  return mapping ? { ...mapping } : null;
}

export function clearDisplayMapping(): void {
  const filePath =
    process.env.RADIONETTE_DISPLAY_MAPPING ||
    radionetteConfigPath("display-mapping.json");
  removeJsonFileWithBackup(filePath);
  mapping = null;
  mappingPath = filePath;
}

export function resolveDisplaySetting(bits: number): DisplaySetting {
  const nibble = bits & 0x0f;
  if (mapping) {
    for (const definition of DEFINITIONS) {
      if (mapping[definition.key] === nibble) {
        return {
          mode: definition.mode,
          bits: nibble,
          mapped: true,
          label: definition.label,
          albumArt: definition.albumArt,
          backlight: definition.backlight,
        };
      }
    }
  }
  return { ...FALLBACK, bits: nibble };
}

export function getDisplayOptions(): DisplayOption[] {
  if (!mapping) {
    return [{ mode: FALLBACK.mode, bits: 0, label: FALLBACK.label }];
  }
  return DEFINITIONS.map((definition) => ({
    mode: definition.mode,
    bits: mapping![definition.key],
    label: definition.label,
  }));
}

export function displayModeAllowsArtwork(mode: DisplayMode): boolean {
  return mode === "auto-artwork" || mode === "always-artwork";
}
