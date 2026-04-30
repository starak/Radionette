/**
 * Smoke test for the GC9A01 display driver inside the radionette runtime.
 *
 * Run on the Pi after `npm run deploy`:
 *
 *   pm2 stop radionette          # release the process so we have the runtime to ourselves
 *   cd ~/code && node dist/scripts/display-smoke.js
 *   pm2 start radionette
 *
 * Expected: red -> green -> blue -> 4 color bars, ~1.5s each, then exits.
 * Last frame stays visible because of PIN_PRESERVE in stopDisplay().
 */

import {
  initDisplay,
  fillScreen,
  testPattern,
  stopDisplay,
} from "../display";

const DC_PIN = 27;
const RESET_PIN = 22;

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

let stopping = false;

async function shutdown(code = 0): Promise<void> {
  if (stopping) return;
  stopping = true;
  try {
    await stopDisplay();
  } catch (err) {
    console.error("[smoke] stopDisplay error:", err);
  }
  process.exit(code);
}

process.on("SIGINT", () => shutdown(130));
process.on("SIGTERM", () => shutdown(143));

async function main(): Promise<void> {
  console.log(`[smoke] initDisplay(dcPin=${DC_PIN}, resetPin=${RESET_PIN})`);
  await initDisplay({ dcPin: DC_PIN, resetPin: RESET_PIN });

  const steps: Array<[string, () => Promise<void>]> = [
    ["red", () => fillScreen(255, 0, 0)],
    ["green", () => fillScreen(0, 255, 0)],
    ["blue", () => fillScreen(0, 0, 255)],
    ["pattern (R/G/B/W bars)", () => testPattern()],
  ];

  for (const [label, fn] of steps) {
    console.log(`[smoke] ${label}`);
    await fn();
    await sleep(1500);
  }

  console.log("[smoke] done — last frame stays via PIN_PRESERVE");
  await shutdown(0);
}

main().catch(async (err) => {
  console.error("[smoke] FAILED:", err);
  await shutdown(1);
});
