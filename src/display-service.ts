/**
 * Display service — glue between radioState events and the GC9A01 panel.
 *
 * Behaviour:
 *   - power off              -> solid black (panel is otherwise inert)
 *   - radio mode + channel   -> channel.logo (or default.png fallback)
 *   - bluetooth, no device   -> bluetooth.png
 *   - bluetooth, connected   -> bluetooth-connected.png
 *
 * Power-on splash: when the radio transitions from off -> on, show
 * default.png for SPLASH_MS before applying the real state. Any state change
 * during the splash window (e.g. user turns the dial) cancels it immediately.
 *
 * On startup the service reads the current state from radioState and applies
 * it once, so we don't sit on a black panel until the first event fires.
 *
 * The actual SPI/render work lives in displayController; this file is purely
 * about translating state into "show this logo" commands.
 */

import * as path from "path";
import { radioState, RadioState } from "./state";
import { displayController } from "./render/displayController";
import { loadLogo } from "./render/logos";

export interface DisplayServiceOptions {
  dcPin: number;
  resetPin: number;
  /** Directory containing channel-logos/*.png|gif. */
  logoDir: string;
  defaultLogo?: string;
  bluetoothLogo?: string;
  bluetoothConnectedLogo?: string;
}

const SPLASH_MS = 2000;

let opts: Required<DisplayServiceOptions> | null = null;
let splashTimer: NodeJS.Timeout | null = null;

function pickLogoForState(s: RadioState): string | null {
  if (!s.power) return null; // signal: black
  // Debug override takes precedence over normal state-based selection while
  // the radio is powered on. Power-off still wins so we don't burn pixels
  // with a forced logo on a "off" panel.
  if (logoOverride) return logoOverride;
  if (s.mode === "bluetooth") {
    return s.bluetoothDevice
      ? opts!.bluetoothConnectedLogo
      : opts!.bluetoothLogo;
  }
  if (s.mode === "radio" && s.channel) {
    return s.channel.logo ?? opts!.defaultLogo;
  }
  // mode === "off" while powered, or radio with no channel, or anything else
  return opts!.defaultLogo;
}

function paint(logo: string | null): void {
  if (logo === null) {
    void displayController.showSolid(0, 0, 0).catch((err) =>
      console.error("[DisplayService] showSolid error:", err),
    );
  } else {
    displayController.showLogo(logo);
  }
}

function clearSplash(): void {
  if (splashTimer) {
    clearTimeout(splashTimer);
    splashTimer = null;
  }
}

let lastApplied: string | null | undefined = undefined;
// While splashActive is true, applyState() suppresses repaints — the
// post-power-on burst (mode change, channel set, player-playing, etc.) all
// flows through but doesn't touch the panel. The splash timer eventually
// flips this off and forces a repaint of the then-current state.
let splashActive = false;

// Debug-only: force a specific logo regardless of state. Set via
// setLogoOverride() from the web debug page. null = no override.
let logoOverride: string | null = null;

function applyState(s: RadioState): void {
  if (splashActive) {
    // Honour ONE exception: if power went off again during the splash window,
    // we want to immediately go black rather than hold default.png.
    if (!s.power) {
      clearSplash();
      splashActive = false;
    } else {
      return;
    }
  }
  const logo = pickLogoForState(s);
  if (logo === lastApplied) return;
  lastApplied = logo;
  paint(logo);
}

function handlePowerOn(): void {
  clearSplash();
  const splashLogo = opts!.defaultLogo;
  splashActive = true;
  lastApplied = splashLogo;
  paint(splashLogo);
  const myTimer = setTimeout(() => {
    if (splashTimer !== myTimer) return; // superseded
    splashTimer = null;
    splashActive = false;
    // Force re-evaluation by clearing lastApplied so applyState always paints.
    lastApplied = undefined;
    applyState(radioState.state);
  }, SPLASH_MS);
  splashTimer = myTimer;
}

export async function initDisplayService(
  o: DisplayServiceOptions,
): Promise<void> {
  opts = {
    defaultLogo: "default.png",
    bluetoothLogo: "bluetooth.png",
    bluetoothConnectedLogo: "bluetooth-connected.png",
    ...o,
  };

  await displayController.init({
    dcPin: opts.dcPin,
    resetPin: opts.resetPin,
    logoDir: opts.logoDir,
    defaultLogo: opts.defaultLogo,
  });

  // Pre-warm the cache for logos that may need to appear instantly. The
  // splash uses defaultLogo on every power-on; the BT logos appear on every
  // BT-mode toggle. Pre-decoding here means the first power-on after boot
  // doesn't sit on black for ~1s while node-canvas chews through the PNG.
  await Promise.all([
    loadLogo(opts.defaultLogo),
    loadLogo(opts.bluetoothLogo),
    loadLogo(opts.bluetoothConnectedLogo),
  ]);

  radioState.on("state:change", applyState);
  radioState.on("power:on", handlePowerOn);

  // Apply current state immediately (covers boot-up where the radio may
  // already be powered with a channel selected before this service started).
  applyState(radioState.state);
}

export async function stopDisplayService(): Promise<void> {
  clearSplash();
  splashActive = false;
  radioState.off("state:change", applyState);
  radioState.off("power:on", handlePowerOn);
  await displayController.shutdown();
  opts = null;
  lastApplied = undefined;
}

/**
 * Helper: produce the absolute path of the logo dir given the current cwd.
 * Centralised so index.ts doesn't have to know the convention.
 */
export function defaultLogoDir(): string {
  return path.resolve(process.cwd(), "assets/channel-logos");
}

/**
 * Debug helper: force a specific logo onto the display, overriding the
 * normal state-driven selection. Pass null to clear the override and resume
 * normal behaviour. Cancels any active splash so the override takes effect
 * immediately.
 */
export function setLogoOverride(ref: string | null): void {
  logoOverride = ref;
  if (splashActive) {
    clearSplash();
    splashActive = false;
  }
  lastApplied = undefined; // force repaint
  applyState(radioState.state);
}

export function getLogoOverride(): string | null {
  return logoOverride;
}
