import consolestamp from "console-stamp";
import { loadChannels } from "./channels";
import { initPlayer, stopPlayer } from "./player";
import { initBluetooth, stopBluetooth } from "./bluetooth";
import { initHotspotAlert, stopHotspotAlert } from "./hotspot-alert";
import { startGpio, stopGpio } from "./gpio";
import { startWebServer, stopWebServer } from "./web";
import { initWifi } from "./wifi";

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

// 5. Start web server (subscribes to state events)
startWebServer();

// 6. Initialize WiFi module (dev-mode detection, API endpoints)
initWifi();

// 7. Start GPIO polling (drives state changes)
startGpio();

console.log("\nRadionette is running. Press Ctrl+C to stop.\n");

// Graceful shutdown
async function shutdown(): Promise<void> {
  console.log("\nShutting down...");
  stopGpio();
  stopHotspotAlert();
  await stopPlayer();
  await stopBluetooth();
  await stopWebServer();
  console.log("Goodbye.");
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
