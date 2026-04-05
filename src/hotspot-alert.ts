import { ChildProcess, execFile } from "child_process";
import * as path from "path";
import { radioState } from "./state";
import { isHotspotActive } from "./wifi";

// Use aplay (ALSA) instead of paplay (PulseAudio) because the hotspot
// bleep needs to work at early boot before PulseAudio is running.
const APLAY = "/usr/bin/aplay";
const ASSETS_DIR = path.resolve(__dirname, "..", "assets");
const BLEEP_FILE = path.join(ASSETS_DIR, "hotspot-bleep.wav");

// How often to check hotspot status when in radio mode (ms)
const POLL_INTERVAL = 5000;

// Delay before retrying after a playback error (ms)
const RETRY_DELAY = 5000;

let pollTimer: ReturnType<typeof setInterval> | null = null;
let bleepProcess: ChildProcess | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let active = false; // true when we're in radio mode and should be polling

/**
 * Start the bleep loop. Plays the WAV file once via aplay, then re-spawns
 * on exit as long as the loop should still be running.
 */
function startBleep(): void {
  if (bleepProcess || retryTimer) return;

  function playOnce(): void {
    if (!active) return;
    retryTimer = null;

    const proc = execFile(
      APLAY,
      ["-q", BLEEP_FILE],
      { timeout: 10000 },
      (err) => {
        if (err && active) {
          console.error("[HotspotAlert] aplay error:", err.message);
        }
        // Re-spawn if still active
        if (proc === bleepProcess) {
          bleepProcess = null;
          if (active) {
            if (err) {
              // Delay retry on error to avoid tight spin loop
              retryTimer = setTimeout(playOnce, RETRY_DELAY);
            } else {
              playOnce();
            }
          }
        }
      }
    );

    bleepProcess = proc;
  }

  console.log("[HotspotAlert] Hotspot detected — starting bleep");
  playOnce();
}

/**
 * Stop the bleep loop immediately.
 */
function stopBleep(): void {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }

  if (!bleepProcess) return;

  const proc = bleepProcess;
  bleepProcess = null;

  try {
    proc.kill("SIGKILL");
  } catch {
    // already dead
  }

  console.log("[HotspotAlert] Bleep stopped");
}

/**
 * Poll hotspot status. Start or stop the bleep based on the result.
 */
async function checkHotspot(): Promise<void> {
  try {
    const hotspot = await isHotspotActive();
    if (hotspot && active) {
      if (!bleepProcess && !retryTimer) startBleep();
    } else {
      if (bleepProcess || retryTimer) {
        console.log("[HotspotAlert] Hotspot no longer active — stopping bleep");
        stopBleep();
      }
    }
  } catch (err: any) {
    console.error("[HotspotAlert] Poll error:", err.message);
  }
}

/**
 * Begin polling for hotspot status (called when entering radio mode).
 */
function startPolling(): void {
  if (pollTimer) return;
  active = true;

  // Check immediately, then every POLL_INTERVAL
  checkHotspot();
  pollTimer = setInterval(checkHotspot, POLL_INTERVAL);
}

/**
 * Stop polling and kill any running bleep (called on mode change).
 */
function stopPolling(): void {
  active = false;

  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  stopBleep();
}

export function initHotspotAlert(): void {
  radioState.on("mode:radio", () => {
    startPolling();
  });

  radioState.on("mode:bluetooth", () => {
    stopPolling();
  });

  radioState.on("power:off", () => {
    stopPolling();
  });

  console.log("[HotspotAlert] Initialized, will bleep when hotspot is active in radio mode.");
}

export function stopHotspotAlert(): void {
  stopPolling();
  console.log("[HotspotAlert] Stopped.");
}
