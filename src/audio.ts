import { execFile, ChildProcess, spawn } from "child_process";
import { radioState } from "./state";

// Absolute paths — pm2 runs with minimal PATH
const PACTL = "/usr/bin/pactl";

const MONO_PREFIX = "mono_mix_";

// Map from real sink name -> remap module ID
const remapModules = new Map<string, number>();

// The original default sink before we enabled mono
let originalDefaultSink: string | null = null;

// Whether mono is currently active
let monoActive = false;

// The pactl subscribe process for watching sink/sink-input events
let subscribeProc: ChildProcess | null = null;

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
 * Get the mono remap-sink name for a given real sink.
 */
function monoSinkName(realSink: string): string {
  return `${MONO_PREFIX}${realSink}`;
}

/**
 * List all real sinks (excludes our mono remap-sinks).
 * Returns array of [index, sinkName].
 */
async function listRealSinks(): Promise<string[]> {
  try {
    const output = await pactl("list", "short", "sinks");
    if (!output) return [];
    return output
      .split("\n")
      .filter((l) => l.trim())
      .map((line) => line.split("\t")[1])
      .filter((name): name is string => !!name && !name.startsWith(MONO_PREFIX));
  } catch {
    return [];
  }
}

/**
 * List all active sink-inputs and which sink they're on.
 * Returns array of { id, sinkIndex }.
 */
async function listSinkInputs(): Promise<{ id: string; sinkIndex: string }[]> {
  try {
    const output = await pactl("list", "short", "sink-inputs");
    if (!output) return [];
    return output
      .split("\n")
      .filter((l) => l.trim())
      .map((line) => {
        const parts = line.split("\t");
        return { id: parts[0], sinkIndex: parts[1] };
      })
      .filter((si) => !!si.id);
  } catch {
    return [];
  }
}

/**
 * Get the sink name for a given sink index.
 */
async function getSinkNameByIndex(index: string): Promise<string | null> {
  try {
    const output = await pactl("list", "short", "sinks");
    if (!output) return null;
    for (const line of output.split("\n")) {
      const parts = line.split("\t");
      if (parts[0] === index) return parts[1];
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Create a mono remap-sink for a given real sink.
 * Returns the module ID, or null if it failed.
 */
async function createRemapForSink(realSink: string): Promise<number | null> {
  const name = monoSinkName(realSink);
  try {
    const result = await pactl(
      "load-module",
      "module-remap-sink",
      `sink_name=${name}`,
      `master=${realSink}`,
      "channels=1",
      "channel_map=mono",
      "remix=yes",
      `sink_properties=device.description="Mono_${realSink}"`
    );
    const moduleId = parseInt(result, 10);
    remapModules.set(realSink, moduleId);
    console.log(`[Audio] Loaded mono remap for ${realSink} (module ${moduleId})`);
    return moduleId;
  } catch (err: any) {
    console.error(`[Audio] Failed to create remap for ${realSink}: ${err.message}`);
    return null;
  }
}

/**
 * Remove the mono remap-sink for a given real sink.
 */
async function removeRemapForSink(realSink: string): Promise<void> {
  const moduleId = remapModules.get(realSink);
  if (moduleId === undefined) return;
  try {
    await pactl("unload-module", String(moduleId));
    console.log(`[Audio] Unloaded mono remap for ${realSink} (module ${moduleId})`);
  } catch (err: any) {
    console.warn(`[Audio] Failed to unload module ${moduleId}: ${err.message}`);
  }
  remapModules.delete(realSink);
}

/**
 * Move all sink-inputs on a real sink to its corresponding mono remap-sink.
 */
async function moveStreamsToMono(realSink: string): Promise<void> {
  const monoName = monoSinkName(realSink);
  const inputs = await listSinkInputs();
  // We need to resolve which sink name each input is on
  for (const { id, sinkIndex } of inputs) {
    const sinkName = await getSinkNameByIndex(sinkIndex);
    if (sinkName === realSink) {
      try {
        await pactl("move-sink-input", id, monoName);
      } catch {
        // Sink-input may have vanished between listing and moving — ignore
      }
    }
  }
}

/**
 * Move all sink-inputs from mono remap-sinks back to their real sinks.
 */
async function moveAllStreamsBackToReal(): Promise<void> {
  const inputs = await listSinkInputs();
  for (const { id, sinkIndex } of inputs) {
    const sinkName = await getSinkNameByIndex(sinkIndex);
    if (sinkName && sinkName.startsWith(MONO_PREFIX)) {
      const realSink = sinkName.slice(MONO_PREFIX.length);
      try {
        await pactl("move-sink-input", id, realSink);
      } catch {
        // Sink-input may have vanished between listing and moving — ignore
      }
    }
  }
}

/**
 * Handle a new sink appearing (e.g. Bluetooth device connects).
 * If mono is active, create a remap-sink for it.
 */
async function onSinkNew(sinkIndex: string): Promise<void> {
  if (!monoActive) return;

  // Brief delay — PulseAudio may not have the sink fully ready yet
  await new Promise((r) => setTimeout(r, 500));

  const sinkName = await getSinkNameByIndex(sinkIndex);
  if (!sinkName || sinkName.startsWith(MONO_PREFIX)) return;
  if (remapModules.has(sinkName)) return; // Already have a remap for this

  console.log(`[Audio] New sink detected while mono active: ${sinkName}`);
  const moduleId = await createRemapForSink(sinkName);
  if (moduleId !== null) {
    // Move any streams that land on the new real sink to its mono remap
    await moveStreamsToMono(sinkName);
  }
}

/**
 * Handle a sink being removed (e.g. Bluetooth device disconnects).
 * Clean up the corresponding remap module if it exists.
 */
function onSinkRemove(sinkIndex: string): void {
  // We can't look up the sink name by index because it's already gone.
  // Instead, check which of our remap modules are now orphaned by listing
  // remaining sinks and comparing.
  // This is handled lazily — the remap module for a removed master sink
  // will be automatically unloaded by PulseAudio, so we just need to
  // clean up our map.
  // We'll do a periodic cleanup or handle it in disableMono().
}

/**
 * Handle a new sink-input appearing.
 * If mono is active, move it to the remap-sink for whatever real sink it's on.
 */
async function onSinkInputNew(inputIndex: string): Promise<void> {
  if (!monoActive) return;

  // Brief delay — sink-input may not be fully set up yet
  await new Promise((r) => setTimeout(r, 200));

  const inputs = await listSinkInputs();
  const input = inputs.find((i) => i.id === inputIndex);
  if (!input) return;

  const sinkName = await getSinkNameByIndex(input.sinkIndex);
  if (!sinkName || sinkName.startsWith(MONO_PREFIX)) return; // Already on a mono sink

  const monoName = monoSinkName(sinkName);
  if (!remapModules.has(sinkName)) return; // No remap for this sink

  try {
    await pactl("move-sink-input", inputIndex, monoName);
  } catch {
    // Sink-input may have vanished between event and move — ignore
  }
}

/**
 * Start the pactl subscribe process to watch for sink and sink-input events.
 */
function startSubscribe(): void {
  if (subscribeProc) return;

  subscribeProc = spawn(PACTL, ["subscribe"], {
    stdio: ["ignore", "pipe", "ignore"],
  });

  subscribeProc.stdout?.setEncoding("utf8");
  subscribeProc.stdout?.on("data", (data: string) => {
    for (const line of data.split("\n")) {
      // Lines look like: Event 'new' on sink #42
      // or: Event 'remove' on sink #42
      // or: Event 'new' on sink-input #7
      const match = line.match(/Event '(\w+)' on (sink-input|sink) #(\d+)/);
      if (!match) continue;
      const [, event, type, index] = match;
      if (type === "sink" && event === "new") {
        onSinkNew(index).catch((err) =>
          console.error("[Audio] onSinkNew error:", err.message)
        );
      } else if (type === "sink" && event === "remove") {
        onSinkRemove(index);
      } else if (type === "sink-input" && event === "new") {
        onSinkInputNew(index).catch((err) =>
          console.error("[Audio] onSinkInputNew error:", err.message)
        );
      }
    }
  });

  subscribeProc.on("exit", (code) => {
    subscribeProc = null;
    if (monoActive) {
      // Restart if it died while mono is active
      console.warn(`[Audio] pactl subscribe exited (code ${code}), restarting...`);
      setTimeout(startSubscribe, 1000);
    }
  });

  console.log("[Audio] Started pactl subscribe watcher");
}

/**
 * Stop the pactl subscribe process.
 */
function stopSubscribe(): void {
  if (subscribeProc) {
    subscribeProc.kill();
    subscribeProc = null;
  }
}

/**
 * Enable mono mixing for all current sinks.
 */
async function enableMono(): Promise<void> {
  if (monoActive) return;
  monoActive = true;

  try {
    // Remember the original default sink
    if (!originalDefaultSink) {
      originalDefaultSink = await pactl("get-default-sink");
      console.log(`[Audio] Original default sink: ${originalDefaultSink}`);
    }

    // Start watching for new sinks/sink-inputs
    startSubscribe();

    // Create remap-sinks for all current real sinks
    const sinks = await listRealSinks();
    for (const sink of sinks) {
      await createRemapForSink(sink);
    }

    // Set the mono version of the original default as the new default
    if (originalDefaultSink && remapModules.has(originalDefaultSink)) {
      await pactl("set-default-sink", monoSinkName(originalDefaultSink));
    }

    // Move all active streams to their corresponding mono sinks
    for (const sink of sinks) {
      await moveStreamsToMono(sink);
    }

    console.log("[Audio] Mono enabled");
  } catch (err: any) {
    console.error("[Audio] Failed to enable mono:", err.message);
  }
}

/**
 * Disable mono mixing: move streams back, unload all remap modules.
 */
async function disableMono(): Promise<void> {
  if (!monoActive) return;
  monoActive = false;

  try {
    // Stop watching for events
    stopSubscribe();

    // Restore original default sink
    if (originalDefaultSink) {
      try {
        await pactl("set-default-sink", originalDefaultSink);
      } catch {
        // Original sink may not exist anymore (e.g. BT disconnected)
      }
    }

    // Move all streams back to real sinks
    await moveAllStreamsBackToReal();

    // Unload all remap modules
    for (const [sink] of remapModules) {
      await removeRemapForSink(sink);
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
  stopSubscribe();
  if (monoActive) {
    disableMono().catch(() => {});
  }
}
