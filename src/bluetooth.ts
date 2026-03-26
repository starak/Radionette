import { ChildProcess, spawn, execFile } from "child_process";
import { radioState } from "./state";
import path from "path";

const BT_ALIAS = "Radionette";
const BT_VOLUME = "120%";

// Absolute paths — pm2 runs with minimal PATH, /usr/sbin may be missing
const RFKILL = "/usr/sbin/rfkill";
const BLUETOOTHCTL = "/usr/bin/bluetoothctl";
const PACTL = "/usr/bin/pactl";
const PAPLAY = "/usr/bin/paplay";

// Sound assets directory (deployed alongside dist/)
const ASSETS_DIR = path.resolve(__dirname, "..", "assets");

let btctlProcess: ChildProcess | null = null;
let enabled = false;

// Track connected device MAC so we can disconnect it later
let connectedMac: string | null = null;
let volumeBoostTimer: ReturnType<typeof setTimeout> | null = null;

// Flap detection — suppress rapid connect/disconnect cycles
const FLAP_WINDOW_MS = 10000; // 10 second window
const FLAP_THRESHOLD = 3;     // 3 disconnects in the window = flapping
// Track disconnect timestamps per MAC address
let disconnectHistory: Map<string, number[]> = new Map();
let suppressedMacs: Set<string> = new Set();
let flapResetTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

// Track the last device that had a stable connection for auto-reconnect
// Only set after a connection has been up for STABLE_THRESHOLD_MS
const STABLE_THRESHOLD_MS = 5000;
let lastStableDevice: { mac: string; name: string } | null = null;
let lastResolvedName: string | null = null; // name of currently connected device
let connectionStartTime: number | null = null;
let stableTimer: ReturnType<typeof setTimeout> | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run a single bluetoothctl command and return stdout.
 * Rejects on non-zero exit or timeout.
 */
function btctl(...args: string[]): Promise<string>;
function btctl(opts: { timeout: number }, ...args: string[]): Promise<string>;
function btctl(...rawArgs: any[]): Promise<string> {
  let timeout = 5000;
  let args: string[];
  if (typeof rawArgs[0] === "object" && rawArgs[0] !== null && "timeout" in rawArgs[0]) {
    timeout = rawArgs[0].timeout;
    args = rawArgs.slice(1);
  } else {
    args = rawArgs;
  }
  return new Promise((resolve, reject) => {
    execFile(BLUETOOTHCTL, args, { timeout }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`bluetoothctl ${args.join(" ")} failed: ${err.message}`));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

/**
 * Run a command (like rfkill) and return stdout.
 */
function run(cmd: string, args: string[], env?: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const opts: any = { timeout: 5000 };
    if (env) {
      opts.env = { ...process.env, ...env };
    }
    execFile(cmd, args, opts, (err: any, stdout: string) => {
      if (err) {
        reject(new Error(`${cmd} ${args.join(" ")} failed: ${err.message}`));
      } else {
        resolve((stdout || "").trim());
      }
    });
  });
}

const PULSE_ENV = {
  PULSE_SERVER: "unix:/run/user/1000/pulse/native",
  PULSE_COOKIE: "/home/pi/.config/pulse/cookie",
};

/**
 * Play a short sound file through PulseAudio.
 * Fire-and-forget — errors are logged but don't block anything.
 */
function playSound(name: string): void {
  const file = path.join(ASSETS_DIR, `${name}.wav`);
  execFile(PAPLAY, [file], {
    timeout: 5000,
    env: { ...process.env, ...PULSE_ENV },
  }, (err) => {
    if (err) {
      console.error(`[Bluetooth] Could not play sound ${name}:`, err.message);
    }
  });
}

/**
 * Boost the volume of Bluetooth sink-inputs in PulseAudio.
 * A2DP audio may not appear immediately after connection, so we
 * retry a few times.
 */
async function boostBluetoothVolume(retries = 5): Promise<void> {
  if (volumeBoostTimer) {
    clearTimeout(volumeBoostTimer);
    volumeBoostTimer = null;
  }

  try {
    // List sink-inputs and find Bluetooth ones
    const output = await run(PACTL, ["list", "sink-inputs"], PULSE_ENV);

    // Parse sink-input blocks
    const blocks = output.split("Sink Input #");
    let boosted = false;

    for (const block of blocks) {
      // Look for bluez/bluetooth indicators in the sink-input properties
      if (/bluez|bluetooth/i.test(block)) {
        const idMatch = block.match(/^(\d+)/);
        if (idMatch) {
          const id = idMatch[1];
          await run(PACTL, ["set-sink-input-volume", id, BT_VOLUME], PULSE_ENV);
          console.log(`[Bluetooth] Boosted sink-input #${id} volume to ${BT_VOLUME}`);
          boosted = true;
        }
      }
    }

    if (!boosted && retries > 0) {
      // A2DP stream may not have started yet, retry after a delay
      volumeBoostTimer = setTimeout(() => {
        boostBluetoothVolume(retries - 1).catch(() => {});
      }, 1000);
    }
  } catch (err: any) {
    if (retries > 0) {
      volumeBoostTimer = setTimeout(() => {
        boostBluetoothVolume(retries - 1).catch(() => {});
      }, 1000);
    } else {
      console.error("[Bluetooth] Failed to boost volume:", err.message);
    }
  }
}

/**
 * Start a long-running bluetoothctl process that monitors events.
 * Registers a NoInputNoOutput agent (auto-accepts pairing) and
 * resolves once the agent is ready.
 */
function startMonitor(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (btctlProcess) {
      resolve();
      return;
    }

    const proc = spawn(BLUETOOTHCTL, [], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    btctlProcess = proc;

    let agentReady = false;
    let buffer = "";

    const handleData = (data: Buffer) => {
      buffer += data.toString();

      // Check the full buffer for agent prompts (they may not end with \n)
      const bufferClean = buffer.replace(/\x1b\[[0-9;]*m/g, "");
      if (/\[agent\]\s*(Confirm passkey|Authorize|Authorize service)/i.test(bufferClean)) {
        console.log(`[Bluetooth] Auto-accepting: ${bufferClean.trim()}`);
        proc.stdin?.write("yes\n");
      }

      // Process complete lines
      const lines = buffer.split("\n");
      buffer = lines.pop() || ""; // keep incomplete last line in buffer

      for (const line of lines) {
        // Detect agent registration success
        if (!agentReady && /Default agent request successful/i.test(line)) {
          agentReady = true;
          resolve();
        }
        parseBtctlLine(line);
      }
    };

    proc.stdout?.on("data", handleData);
    proc.stderr?.on("data", handleData);

    proc.on("exit", (code, signal) => {
      if (proc === btctlProcess) {
        btctlProcess = null;
        // Restart monitor if bluetooth is still supposed to be enabled
        if (enabled) {
          console.log("[Bluetooth] Monitor exited unexpectedly, restarting...");
          setTimeout(() => startMonitor().catch(() => {}), 1000);
        }
      }
      if (!agentReady) {
        reject(new Error("bluetoothctl exited before agent was ready"));
      }
    });

    proc.on("error", (err) => {
      console.error("[Bluetooth] Monitor error:", err.message);
      if (proc === btctlProcess) {
        btctlProcess = null;
      }
      if (!agentReady) {
        reject(err);
      }
    });

    // Wait for bluetoothctl to connect to bluetoothd, then register agent
    setTimeout(() => {
      if (proc !== btctlProcess) return;
      proc.stdin?.write("agent DisplayYesNo\n");
      setTimeout(() => {
        if (proc !== btctlProcess) return;
        proc.stdin?.write("default-agent\n");
      }, 500);
    }, 500);

    // Safety timeout — don't hang forever
    setTimeout(() => {
      if (!agentReady) {
        agentReady = true; // prevent double resolve/reject
        console.warn("[Bluetooth] Agent registration timed out, continuing anyway");
        resolve();
      }
    }, 5000);
  });
}

function stopMonitor(): void {
  if (!btctlProcess) return;
  const proc = btctlProcess;
  btctlProcess = null;
  try {
    proc.stdin?.write("quit\n");
    proc.kill("SIGTERM");
  } catch {
    // already dead
  }
}

/**
 * Parse a line from the bluetoothctl monitor output.
 *
 * Lines we care about:
 *   [CHG] Device AA:BB:CC:DD:EE:FF Connected: yes
 *   [CHG] Device AA:BB:CC:DD:EE:FF Connected: no
 *   [CHG] Device AA:BB:CC:DD:EE:FF Name: iPhone
 *   [NEW] Device AA:BB:CC:DD:EE:FF iPhone
 *   [DEL] Device AA:BB:CC:DD:EE:FF iPhone
 */
function parseBtctlLine(line: string): void {
  // Strip ANSI escape codes and bluetoothctl prompt artifacts
  const clean = line.replace(/\x1b\[[0-9;]*m/g, "").replace(/\[.*?#\]\s*/g, "").trim();

  // Device connected
  const connMatch = clean.match(
    /\[CHG\]\s+Device\s+([0-9A-F:]{17})\s+Connected:\s+yes/i
  );
  if (connMatch) {
    const mac = connMatch[1];
    if (suppressedMacs.has(mac)) return; // suppress during flap
    connectedMac = mac;
    connectionStartTime = Date.now();
    console.log(`[Bluetooth] Device connected: ${mac}`);
    playSound("bt-connect");
    // Trust the device so it can auto-reconnect in the future
    btctl("trust", mac).catch(() => {});
    // Try to get device name — it may arrive in a separate line,
    // but we can also query it
    resolveDeviceName(mac);
    // Boost volume once audio stream appears
    boostBluetoothVolume().catch(() => {});
    // Start a timer to mark this as a stable connection
    if (stableTimer) clearTimeout(stableTimer);
    stableTimer = setTimeout(() => {
      if (connectedMac === mac) {
        // Connection has been up long enough — mark as stable
        const name = lastResolvedName || mac;
        lastStableDevice = { mac, name };
        console.log(`[Bluetooth] Stable connection established with ${name}`);
      }
    }, STABLE_THRESHOLD_MS);
    return;
  }

  // Device disconnected
  const discMatch = clean.match(
    /\[CHG\]\s+Device\s+([0-9A-F:]{17})\s+Connected:\s+no/i
  );
  if (discMatch) {
    const mac = discMatch[1];
    if (suppressedMacs.has(mac)) return; // already suppressed

    // Cancel the stable-connection timer
    if (stableTimer) { clearTimeout(stableTimer); stableTimer = null; }

    if (mac === connectedMac) {
      connectedMac = null;
      connectionStartTime = null;
    }

    // Flap detection — track disconnects per MAC
    const now = Date.now();
    let timestamps = disconnectHistory.get(mac) || [];
    timestamps.push(now);
    timestamps = timestamps.filter((t) => now - t < FLAP_WINDOW_MS);
    disconnectHistory.set(mac, timestamps);

    if (timestamps.length >= FLAP_THRESHOLD) {
      suppressedMacs.add(mac);
      console.log(
        `[Bluetooth] Connection flapping detected for ${mac} — removing device`
      );
      radioState.setBluetoothDevice(null);
      // Clear lastStableDevice if it's this MAC
      if (lastStableDevice?.mac === mac) {
        lastStableDevice = null;
      }
      // Remove the device from BlueZ to stop the reconnection loop
      btctl("remove", mac).then(
        () => console.log(`[Bluetooth] Removed flapping device ${mac}`),
        () => console.log(`[Bluetooth] Could not remove device ${mac}`)
      );
      // Reset suppression after a cooldown so the device can pair fresh
      const existingTimer = flapResetTimers.get(mac);
      if (existingTimer) clearTimeout(existingTimer);
      flapResetTimers.set(mac, setTimeout(() => {
        suppressedMacs.delete(mac);
        disconnectHistory.delete(mac);
        flapResetTimers.delete(mac);
      }, 30000)); // 30 second cooldown
      return;
    }

    console.log(`[Bluetooth] Device disconnected: ${mac}`);
    playSound("bt-ready");
    radioState.setBluetoothDevice(null);
    return;
  }

  // Device name update (sometimes arrives after connection)
  const nameMatch = clean.match(
    /\[CHG\]\s+Device\s+([0-9A-F:]{17})\s+Name:\s+(.+)/i
  );
  if (nameMatch) {
    const mac = nameMatch[1];
    const name = nameMatch[2].trim();
    if (mac === connectedMac && name) {
      console.log(`[Bluetooth] Device name: ${name}`);
      radioState.setBluetoothDevice(name);
    }
    return;
  }
}

/**
 * Query bluetoothctl for a device's name and update state.
 */
async function resolveDeviceName(mac: string): Promise<void> {
  try {
    const info = await btctl("info", mac);
    const nameMatch = info.match(/Name:\s+(.+)/);
    const name = nameMatch ? nameMatch[1].trim() : mac;
    if (connectedMac === mac) {
      console.log(`[Bluetooth] Connected device: ${name}`);
      lastResolvedName = name;
      radioState.setBluetoothDevice(name);
    }
  } catch {
    // If info fails, just use the MAC address
    if (connectedMac === mac) {
      lastResolvedName = mac;
      radioState.setBluetoothDevice(mac);
    }
  }
}

/**
 * Try to reconnect to the last successfully connected device.
 * Runs in the background — does not block enableBluetooth.
 */
async function reconnectLastDevice(): Promise<void> {
  if (!lastStableDevice) {
    console.log("[Bluetooth] No previous device to reconnect.");
    return;
  }

  const { mac, name } = lastStableDevice;

  // Verify the device is still known to BlueZ
  try {
    await btctl("info", mac);
  } catch {
    console.log(`[Bluetooth] Last device ${name} (${mac}) no longer known to BlueZ.`);
    lastStableDevice = null;
    return;
  }

  if (!enabled) return;
  console.log(`[Bluetooth] Attempting to reconnect: ${name} (${mac})`);
  try {
    await btctl({ timeout: 15000 }, "connect", mac);
    console.log(`[Bluetooth] Reconnected to ${name}`);
  } catch {
    console.log(`[Bluetooth] Could not reconnect to ${name} (device may be out of range)`);
  }
}

async function enableBluetooth(): Promise<void> {
  if (enabled) return;
  enabled = true;

  console.log("[Bluetooth] Enabling...");

  // Reset flap detection
  suppressedMacs.clear();
  disconnectHistory.clear();
  for (const timer of flapResetTimers.values()) clearTimeout(timer);
  flapResetTimers.clear();

  try {
    // Unblock the adapter
    await run(RFKILL, ["unblock", "bluetooth"]);

    // Wait for BlueZ to notice the adapter is unblocked
    await sleep(500);

    // Power on — retry a few times since BlueZ may need a moment
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        await btctl("power", "on");
        break;
      } catch (err: any) {
        if (attempt === 5) throw err;
        console.log(`[Bluetooth] Power on attempt ${attempt} failed, retrying...`);
        await sleep(500);
      }
    }

    // Start the monitor and register auto-accept agent BEFORE
    // enabling discoverable, so pairing requests are handled
    await startMonitor();

    // Set the friendly name
    await btctl("system-alias", BT_ALIAS);

    // Make discoverable and pairable
    await btctl("discoverable", "on");
    await btctl("pairable", "on");

    console.log(`[Bluetooth] Enabled — discoverable as "${BT_ALIAS}"`);
    playSound("bt-ready");

    // Try to reconnect to a previously trusted device (don't await — background)
    reconnectLastDevice();
  } catch (err: any) {
    console.error("[Bluetooth] Failed to enable:", err.message);
  }
}

async function disableBluetooth(): Promise<void> {
  if (!enabled) return;
  enabled = false;

  console.log("[Bluetooth] Disabling...");

  // Cancel any pending volume boost
  if (volumeBoostTimer) {
    clearTimeout(volumeBoostTimer);
    volumeBoostTimer = null;
  }

  // Reset flap detection
  suppressedMacs.clear();
  disconnectHistory.clear();
  for (const timer of flapResetTimers.values()) clearTimeout(timer);
  flapResetTimers.clear();

  // Cancel stable connection timer
  if (stableTimer) { clearTimeout(stableTimer); stableTimer = null; }
  lastResolvedName = null;

  try {
    // Disconnect any connected device
    if (connectedMac) {
      await btctl("disconnect", connectedMac).catch(() => {});
      connectedMac = null;
    }

    // Stop monitor first (it holds the agent)
    stopMonitor();

    // Disable discoverability and pairing
    await btctl("discoverable", "off").catch(() => {});
    await btctl("pairable", "off").catch(() => {});

    // Power off the adapter
    await btctl("power", "off").catch(() => {});

    radioState.setBluetoothDevice(null);

    console.log("[Bluetooth] Disabled.");
  } catch (err: any) {
    console.error("[Bluetooth] Error during disable:", err.message);
  }
}

export function initBluetooth(): void {
  radioState.on("mode:bluetooth", () => {
    enableBluetooth();
  });

  radioState.on("mode:radio", () => {
    disableBluetooth();
  });

  radioState.on("power:off", () => {
    disableBluetooth();
  });

  console.log("[Bluetooth] Initialized, listening for state changes.");
}

export async function stopBluetooth(): Promise<void> {
  await disableBluetooth();
  console.log("[Bluetooth] Stopped.");
}
