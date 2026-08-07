import consolestamp from "console-stamp";
import { loadChannels } from "./channels";
import { initPlayer, stopPlayer } from "./player";
import { initBluetooth, stopBluetooth } from "./bluetooth";
import { initHotspotAlert, stopHotspotAlert } from "./hotspot-alert";
import { initAudio, stopAudio } from "./audio";
import { startGpio, stopGpio, getBacklightHandle } from "./gpio";
import { startBacklight, stopBacklight } from "./backlight";
import { startWebServer, stopWebServer } from "./web";
import { initWifi } from "./wifi";
import { initAdc, stopAdc } from "./adc";
import { initVolume, stopVolume } from "./volume";
import { initTuner, stopTuner } from "./tuner";
import {
  initDisplayService,
  stopDisplayService,
  defaultLogoDir,
} from "./display-service";

const DISPLAY_DC_PIN = 27;
const DISPLAY_RESET_PIN = 22;

// Route warnings to stdout so pm2 keeps startup+status messages in the
// same log file as normal output. Real errors still go to stderr via
// console.error. Do this before console-stamp attaches its formatter.
console.warn = console.log;

consolestamp(console, { format: ":date(yyyy-mm-dd HH:MM:ss.l)" });

console.log("=== Radionette ===");
console.log("Starting up...\n");

// 1. Load channel configuration
loadChannels();

// 2. Initialize player (subscribes to state events)
initPlayer();

// 3. Initialize bluetooth (subscribes to state events)
initBluetooth();

// 4. Initialize hotspot alert (bleeps when in radio mode + hotspot active)
initHotspotAlert();

// 5. Initialize audio (mono/stereo switching via PulseAudio)
initAudio();

// 6. Start web server (subscribes to state events)
startWebServer();

// 7. Initialize WiFi module (dev-mode detection, API endpoints)
initWifi();

// 8. Open the shared ADS1115 (I2C bus 1). Must come BEFORE volume and
//    tuner, both of which read individual channels via adc.ts.
initAdc();

// 9. Start the tuner BEFORE gpio so gpio.ts can query isTunerActive()
//    on its very first debounced read.
initTuner();

// 10. Start GPIO polling (drives state changes, feeds band into tuner)
startGpio();

// 10b. Start backlight controller (PWM on the backlight pin opened by gpio.ts).
//      Must come AFTER startGpio() so the pin is already in OUTPUT mode.
const blHandle = getBacklightHandle();
if (blHandle) {
  startBacklight(blHandle.rpio, blHandle.pin);
} else {
  console.warn("[Backlight] No GPIO handle (dev mode) — backlight inactive");
}

// 11. Initialize volume (reads AIN0 via adc.ts)
initVolume();

// 12. Initialize display service. Done last so all state-emitting modules are
//     already wired; the service immediately paints the current state.
//     Any failure here must NOT take down the rest of the radio.
initDisplayService({
  dcPin: DISPLAY_DC_PIN,
  resetPin: DISPLAY_RESET_PIN,
  logoDir: defaultLogoDir(),
}).catch((err) => {
  console.error("[Display] init failed (continuing without display):", err);
});

console.log("\nRadionette is running.\n");

// Graceful shutdown
async function shutdown(): Promise<void> {
  console.log("\nShutting down...");
  // Stop the display first so PIN_PRESERVE leaves the last logo on the panel
  // before any other module tears down GPIO/SPI underneath us.
  try {
    await stopDisplayService();
  } catch (err) {
    console.error("[Display] shutdown error:", err);
  }
  stopVolume();
  stopTuner();
  stopAdc();
  // Stop backlight before gpio.ts closes the pin.
  stopBacklight();
  stopGpio();
  stopHotspotAlert();
  stopAudio();
  await stopPlayer();
  await stopBluetooth();
  await stopWebServer();
  console.log("Goodbye.");
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
