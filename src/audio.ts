import { execFile } from "child_process";
import { radioState } from "./state";

// Absolute paths — pm2 runs with minimal PATH
const PACTL = "/usr/bin/pactl";

const MONO_SINK_NAME = "mono_mix";

let monoModuleId: number | null = null;
let hwSinkName: string | null = null;

/**
 * Run a pactl command and return stdout.
 */
function pactl(...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(PACTL, args, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`pactl ${args.join(" ")} failed: ${stderr || err.message}`));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

/**
 * Detect the default hardware sink name.
 */
async function detectHwSink(): Promise<string> {
  // `pactl get-default-sink` returns the current default sink name
  const name = await pactl("get-default-sink");
  if (!name) throw new Error("No default sink found");
  return name;
}

/**
 * Move all active sink-inputs to the given sink.
 * This ensures currently playing streams switch over immediately.
 */
async function moveAllStreamsToSink(sinkName: string): Promise<void> {
  try {
    const output = await pactl("list", "short", "sink-inputs");
    if (!output) return;
    const lines = output.split("\n").filter((l) => l.trim());
    for (const line of lines) {
      const id = line.split("\t")[0];
      if (id) {
        try {
          await pactl("move-sink-input", id, sinkName);
        } catch (err: any) {
          console.warn(`[Audio] Failed to move sink-input ${id}: ${err.message}`);
        }
      }
    }
  } catch {
    // No active streams — nothing to move
  }
}

/**
 * Enable mono mixing: load a remap-sink that downmixes stereo to mono,
 * set it as default, and move active streams to it.
 */
async function enableMono(): Promise<void> {
  try {
    // Detect and remember the hardware sink before we change the default
    if (!hwSinkName) {
      hwSinkName = await detectHwSink();
      console.log(`[Audio] Hardware sink: ${hwSinkName}`);
    }

    // Load the remap module — downmixes stereo L+R into a single mono channel
    const result = await pactl(
      "load-module",
      "module-remap-sink",
      `sink_name=${MONO_SINK_NAME}`,
      `master=${hwSinkName}`,
      "channels=1",
      "channel_map=mono",
      "master_channel_map=front-left,front-right",
      `sink_properties=device.description="Mono\\ Mix"`
    );
    monoModuleId = parseInt(result, 10);
    console.log(`[Audio] Loaded mono remap-sink (module ${monoModuleId})`);

    // Set mono as default so new streams go through it
    await pactl("set-default-sink", MONO_SINK_NAME);

    // Move any active streams to the mono sink
    await moveAllStreamsToSink(MONO_SINK_NAME);

    console.log("[Audio] Mono enabled");
  } catch (err: any) {
    console.error("[Audio] Failed to enable mono:", err.message);
  }
}

/**
 * Disable mono mixing: unload the remap-sink, restore the hardware sink
 * as default, and move active streams back.
 */
async function disableMono(): Promise<void> {
  try {
    // Restore hardware sink as default first, so new streams go there
    if (hwSinkName) {
      await pactl("set-default-sink", hwSinkName);
    }

    // Move active streams back to hardware sink before unloading
    if (hwSinkName) {
      await moveAllStreamsToSink(hwSinkName);
    }

    // Unload the remap module
    if (monoModuleId !== null) {
      await pactl("unload-module", String(monoModuleId));
      console.log(`[Audio] Unloaded mono remap-sink (module ${monoModuleId})`);
      monoModuleId = null;
    }

    console.log("[Audio] Stereo restored");
  } catch (err: any) {
    console.error("[Audio] Failed to disable mono:", err.message);
  }
}

export function initAudio(): void {
  radioState.on("mono:on", () => {
    enableMono();
  });

  radioState.on("mono:off", () => {
    disableMono();
  });

  console.log("[Audio] Initialized, listening for mono/stereo changes on GPIO");
}

export function stopAudio(): void {
  if (monoModuleId !== null) {
    disableMono().catch(() => {});
  }
}
