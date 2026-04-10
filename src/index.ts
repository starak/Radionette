import consolestamp from "console-stamp";
import { loadChannels } from "./channels";
import { initPlayer, stopPlayer } from "./player";
import { initBluetooth, stopBluetooth } from "./bluetooth";
import { initHotspotAlert, stopHotspotAlert } from "./hotspot-alert";
import { initAudio, stopAudio } from "./audio";
import { startGpio, stopGpio } from "./gpio";
import { startWebServer, stopWebServer } from "./web";
import { initWifi } from "./wifi";
import { initVolume, stopVolume } from "./volume";

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

// 8. Start GPIO polling (drives state changes)
startGpio();

// 9. Initialize volume ADC (I2C ADS1115 → PulseAudio master volume)
initVolume();

console.log("\nRadionette is running.\n");

// Graceful shutdown
async function shutdown(): Promise<void> {
  console.log("\nShutting down...");
  stopVolume();
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
