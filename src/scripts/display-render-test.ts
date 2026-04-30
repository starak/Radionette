/**
 * Render-test CLI for the display rendering pipeline.
 *
 * Run on the Pi after `npm run deploy`:
 *
 *   pm2 stop radionette
 *   cd ~/code && node dist/scripts/display-render-test.js
 *   pm2 start radionette
 *
 * What it does:
 *   1. Initialises the display on the production pins (D/C=27, RESET=22).
 *   2. Iterates every channel in channels.json and shows its logo for ~2s.
 *   3. Shows the bluetooth.png and bluetooth-connected.png logos.
 *   4. Shows the default fallback logo (via an intentionally-missing ref).
 *   5. Shuts down cleanly, leaving the last frame on the panel.
 *
 * Anything missing on disk is logged but doesn't abort the test — you'll see
 * the fallback (default.png or solid black) instead.
 */

import * as path from "path";
import { loadChannels, getAllChannels } from "../channels";
import { displayController } from "../render/displayController";

const DC_PIN = 27;
const RESET_PIN = 22;
const LOGO_DIR = path.resolve(process.cwd(), "assets/channel-logos");
const HOLD_MS = 2000;

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

let stopping = false;
async function shutdown(code = 0): Promise<void> {
  if (stopping) return;
  stopping = true;
  try {
    await displayController.shutdown();
  } catch (err) {
    console.error("[render-test] shutdown error:", err);
  }
  process.exit(code);
}
process.on("SIGINT", () => shutdown(130));
process.on("SIGTERM", () => shutdown(143));

async function main(): Promise<void> {
  loadChannels();
  await displayController.init({
    dcPin: DC_PIN,
    resetPin: RESET_PIN,
    logoDir: LOGO_DIR,
    defaultLogo: "default.png",
  });

  const channels = getAllChannels();
  console.log(`[render-test] cycling ${channels.length} channel logos (${HOLD_MS}ms each)`);
  for (const ch of channels) {
    console.log(`  ${ch.number.toString().padStart(3)}  ${ch.name}  -> ${ch.logo ?? "(no logo)"}`);
    displayController.showLogo(ch.logo);
    await sleep(HOLD_MS);
  }

  console.log("[render-test] bluetooth.png");
  displayController.showLogo("bluetooth.png");
  await sleep(HOLD_MS);

  console.log("[render-test] bluetooth-connected.png");
  displayController.showLogo("bluetooth-connected.png");
  await sleep(HOLD_MS);

  console.log("[render-test] missing-ref -> should fall back to default.png");
  displayController.showLogo("__definitely_missing__.png");
  await sleep(HOLD_MS);

  console.log("[render-test] done — leaving last frame on panel");
  await shutdown(0);
}

main().catch(async (err) => {
  console.error("[render-test] FAILED:", err);
  await shutdown(1);
});
