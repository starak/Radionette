/**
 * Display orchestrator.
 *
 * Owns the GC9A01 driver lifecycle, a single-slot frame queue, and the
 * animation timer for animated logos. The display-service layer (which
 * listens to radioState events) only needs to call:
 *
 *   await displayController.init({ dcPin, resetPin, logoDir });
 *   await displayController.showLogo("NRK-P1.png");   // fire-and-forget OK
 *   await displayController.showSolid(0, 0, 0);       // power off look
 *   await displayController.shutdown();
 *
 * Concurrency:
 *   - At most one SPI transfer happens at a time.
 *   - If showLogo() is called while a previous one is mid-flight, the newer
 *     request supersedes the older (we only care about painting the latest
 *     intent — older requests are dropped without error).
 *   - Animation timing runs off the latest logo only; switching logos cancels
 *     any pending animation tick.
 */

import {
  initDisplay,
  drawRgb565Buffer,
  stopDisplay,
} from "../display";
import { loadLogo, configureLogos, RenderedLogo } from "./logos";
import { solidFrame } from "./frame";

export interface DisplayInitOptions {
  dcPin: number;
  resetPin: number;
  logoDir: string;
  defaultLogo?: string;
}

let initialised = false;
let stopping = false;

// Currently-displayed (or about-to-be-displayed) logo state.
let activeLogo: RenderedLogo | null = null;
let activeFrameIdx = 0;
let animTimer: NodeJS.Timeout | null = null;

// Single-slot pending request: latest desired logo path. If a paint is in
// flight, this gets picked up on the next loop iteration.
let pendingRef: string | null | undefined = undefined; // undefined = nothing pending
let painting = false;

function clearAnim(): void {
  if (animTimer) {
    clearTimeout(animTimer);
    animTimer = null;
  }
}

async function paintFrame(buf: Buffer): Promise<void> {
  if (!initialised || stopping) return;
  await drawRgb565Buffer(buf);
}

function scheduleNextAnimFrame(): void {
  clearAnim();
  if (!activeLogo || !activeLogo.animated) return;
  const cur = activeLogo.frames[activeFrameIdx];
  animTimer = setTimeout(async () => {
    if (!activeLogo) return;
    activeFrameIdx = (activeFrameIdx + 1) % activeLogo.frames.length;
    const next = activeLogo.frames[activeFrameIdx];
    try {
      await paintFrame(next.rgb565);
    } catch (err) {
      console.error("[Display] anim paint error:", err);
    }
    scheduleNextAnimFrame();
  }, cur.delayMs);
}

async function drainQueue(): Promise<void> {
  if (painting) return;
  painting = true;
  try {
    while (pendingRef !== undefined) {
      const ref = pendingRef;
      pendingRef = undefined;
      clearAnim();
      const logo = await loadLogo(ref);
      // While we were loading, a newer request may have arrived — if so, drop
      // this one and loop again so we paint the latest intent.
      if (pendingRef !== undefined) continue;
      activeLogo = logo;
      activeFrameIdx = 0;
      await paintFrame(logo.frames[0].rgb565);
      scheduleNextAnimFrame();
    }
  } finally {
    painting = false;
  }
}

export const displayController = {
  async init(opts: DisplayInitOptions): Promise<void> {
    if (initialised) return;
    configureLogos({ logoDir: opts.logoDir, defaultLogo: opts.defaultLogo });
    await initDisplay({ dcPin: opts.dcPin, resetPin: opts.resetPin });
    initialised = true;
    // Start with a black frame so the panel isn't showing leftover bytes.
    await paintFrame(solidFrame(0, 0, 0));
    console.log(
      `[Display] Initialised on D/C=GPIO${opts.dcPin} RST=GPIO${opts.resetPin}, logoDir=${opts.logoDir}`,
    );
  },

  /**
   * Request that a logo be shown. Fire-and-forget; returns when the request
   * has been queued (NOT when paint completes). If you need to await the
   * actual paint, await drainQueue() externally — but normally callers don't
   * care.
   *
   * Passing `undefined` or a missing-file ref triggers the default fallback.
   */
  showLogo(ref: string | undefined | null): void {
    if (!initialised || stopping) return;
    pendingRef = ref ?? null;
    void drainQueue().catch((err) =>
      console.error("[Display] drainQueue error:", err),
    );
  },

  /** Paint a single solid colour immediately (cancels any animation). */
  async showSolid(r: number, g: number, b: number): Promise<void> {
    if (!initialised || stopping) return;
    clearAnim();
    activeLogo = null;
    pendingRef = undefined;
    await paintFrame(solidFrame(r, g, b));
  },

  async shutdown(): Promise<void> {
    if (!initialised || stopping) return;
    stopping = true;
    clearAnim();
    pendingRef = undefined;
    // Wait briefly for any in-flight paint to finish so PIN_PRESERVE leaves
    // a coherent last frame on screen.
    const deadline = Date.now() + 500;
    while (painting && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    await stopDisplay();
    initialised = false;
    console.log("[Display] Shut down (last frame preserved on panel)");
  },

  isInitialised(): boolean {
    return initialised;
  },
};
