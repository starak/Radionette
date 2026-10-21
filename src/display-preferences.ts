import { getTint, setTint, Tint } from "./render/frame";
import { radionetteConfigPath, readJsonFile, writeJsonAtomic } from "./config-storage";

interface DisplayPreferencesFile {
  tint: Tint;
}

const FILE_PATH = radionetteConfigPath("display-preferences.json");
let savedTint: Tint = { ...getTint() };

function validateTint(value: any): Tint {
  const tint = value?.tint ?? value;
  for (const key of ["r", "g", "b"] as const) {
    if (typeof tint?.[key] !== "number" || !Number.isFinite(tint[key]) || tint[key] < 0 || tint[key] > 2) {
      throw new Error(`tint.${key} must be a number from 0 to 2`);
    }
  }
  return { r: tint.r, g: tint.g, b: tint.b };
}

export function loadDisplayPreferences(): void {
  try {
    const saved = readJsonFile<DisplayPreferencesFile>(FILE_PATH);
    if (!saved) {
      console.log(`[DisplayPreferences] No saved preferences at ${FILE_PATH}; using defaults`);
      return;
    }
    const tint = validateTint(saved);
    savedTint = { ...tint };
    setTint(tint);
    console.log(`[DisplayPreferences] Loaded tint r=${tint.r} g=${tint.g} b=${tint.b}`);
  } catch (err) {
    console.error(`[DisplayPreferences] Failed to load ${FILE_PATH}:`, err);
  }
}

export function saveDefaultTint(value: unknown): Tint {
  const tint = validateTint(value);
  writeJsonAtomic(FILE_PATH, { tint });
  savedTint = { ...tint };
  return tint;
}

export function getDisplayPreferences(): DisplayPreferencesFile {
  return { tint: { ...savedTint } };
}

export function validateDisplayPreferences(value: unknown): DisplayPreferencesFile {
  return { tint: validateTint(value) };
}
