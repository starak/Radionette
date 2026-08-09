/**
 * Tuner static burst.
 *
 * Plays a short (~600 ms) white-noise burst through the current default
 * PulseAudio sink whenever the tuner (or the rotary-band fallback in
 * gpio.ts) switches to a different channel. The intent is to mimic the
 * inter-station hiss of an analog radio: mostly a UX flourish, but it
 * also usefully bridges the ~0.3-1 s gap while ffmpeg/mpg123 respawns
 * and buffers the next stream.
 *
 * The burst is fired via `paplay` (no --device) so it lands on the same
 * default sink that audio.ts routes the stream player to. That means
 * mono/stereo re-routing done by audio.ts is honoured, and the burst
 * rides the same physical volume knob.
 *
 * Overlap policy: if a burst is already in flight when a new trigger
 * arrives, the in-flight one is SIGKILLed and a new one is spawned.
 * Spinning the tuner past several wedges therefore sounds like one
 * continuous shhhhh, not N stacked bursts.
 *
 * Dedupe: identical trigger (same channel id) within DEDUPE_MS is
 * dropped so the tuner + gpio-fallback paths both calling us for the
 * same event don't double-fire.
 *
 * Gated on `mode === "radio"` and `power === true` — no static in
 * Bluetooth mode, no static when the set is off.
 */

import { ChildProcess, execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { radioState } from "./state";

const PAPLAY = "/usr/bin/paplay";
const ASSETS_DIR = path.resolve(__dirname, "..", "assets");
const WAV_FILE = path.join(ASSETS_DIR, "tuner-static.wav");

// Two triggers landing within this window count as one event.
const DEDUPE_MS = 120;

let ready = false;
let currentProc: ChildProcess | null = null;
let lastChannelId: string | null = null;
let lastAt = 0;

export function initStaticNoise(): void {
  if (!fs.existsSync(PAPLAY)) {
    console.log(
      `[StaticNoise] paplay not found at ${PAPLAY} — static burst disabled`
    );
    return;
  }
  if (!fs.existsSync(WAV_FILE)) {
    console.log(
      `[StaticNoise] WAV file not found at ${WAV_FILE} — static burst disabled`
    );
    return;
  }
  ready = true;
  console.log(`[StaticNoise] Ready (wav=${WAV_FILE})`);
}

/**
 * Fire a static burst for a channel change. Safe to call from multiple
 * code paths for the same logical event — dedupe handles that.
 *
 * @param channelId Identifier of the channel being switched TO. Used
 *   only for dedupe; may be null (e.g. band with no channels — still
 *   worth a burst so silence sounds intentional).
 */
export function playTunerStatic(channelId: string | null): void {
  if (!ready) return;
  if (!radioState.state.power) return;
  if (radioState.state.mode !== "radio") return;

  const now = Date.now();
  if (
    channelId !== null &&
    channelId === lastChannelId &&
    now - lastAt < DEDUPE_MS
  ) {
    return;
  }
  lastChannelId = channelId;
  lastAt = now;

  // Kill any in-flight burst so overlapping triggers sound like one
  // continuous shhhhh rather than N stacked bursts.
  if (currentProc) {
    try {
      currentProc.kill("SIGKILL");
    } catch {
      // already dead
    }
    currentProc = null;
  }

  const proc = execFile(
    PAPLAY,
    [WAV_FILE],
    (err) => {
      if (proc === currentProc) currentProc = null;
      if (err && (err as NodeJS.ErrnoException).code !== "SIGKILL" && err.signal !== "SIGKILL") {
        // paplay writes nothing to stdout normally; only log actual failures.
        const msg = err.message.split("\n")[0];
        if (msg && !msg.includes("SIGKILL")) {
          console.warn(`[StaticNoise] paplay: ${msg}`);
        }
      }
    }
  );
  currentProc = proc;
}

export function stopStaticNoise(): void {
  if (currentProc) {
    try {
      currentProc.kill("SIGKILL");
    } catch {
      // already dead
    }
    currentProc = null;
  }
}
