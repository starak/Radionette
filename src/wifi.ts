import { execFile } from "child_process";
import { radioState } from "./state";

// Absolute paths — pm2 runs with minimal PATH
const NMCLI = "/usr/bin/nmcli";
const SYSTEMCTL = "/usr/bin/systemctl";

// Hotspot configuration
const AP_SSID = "Radionette-Setup";
const AP_CON_NAME = "radionette-hotspot";

export interface WifiNetwork {
  ssid: string;
  signal: number;
  security: string;
  active: boolean;
}

export interface WifiStatus {
  connected: boolean;
  ssid: string | null;
  ip: string | null;
  hotspotActive: boolean;
}

// Dev-mode flag — set if nmcli is not available (running on laptop)
let devMode = false;

/**
 * Run an nmcli command and return stdout.
 * Rejects on non-zero exit or timeout.
 */
function nmcli(...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(NMCLI, args, { timeout: 10000 }, (err, stdout) => {
      if (err) {
        reject(new Error(`nmcli ${args.join(" ")} failed: ${err.message}`));
      } else {
        resolve((stdout || "").trim());
      }
    });
  });
}

/**
 * Check if nmcli is available. If not, enable dev mode.
 */
async function checkDevMode(): Promise<void> {
  try {
    await nmcli("general", "status");
  } catch {
    devMode = true;
    console.log("[WiFi] nmcli not available — running in dev mode");
  }
}

// Run check at module load
checkDevMode();

/**
 * Get current WiFi connection status.
 */
export async function getWifiStatus(): Promise<WifiStatus> {
  if (devMode) {
    return { connected: true, ssid: "DevNetwork", ip: "127.0.0.1", hotspotActive: false };
  }

  try {
    // Check if hotspot is active
    const hotspotActive = await isHotspotActive();

    // Get wlan0 device status
    const output = await nmcli("-t", "-f", "GENERAL.STATE,GENERAL.CONNECTION,IP4.ADDRESS", "device", "show", "wlan0");
    const lines = output.split("\n");

    let connected = false;
    let ssid: string | null = null;
    let ip: string | null = null;
    let connectionName: string | null = null;

    for (const line of lines) {
      const [key, value] = line.split(":", 2);
      if (!key || !value) continue;

      if (key === "GENERAL.STATE" && value.includes("connected")) {
        connected = true;
      }
      if (key === "GENERAL.CONNECTION" && value && value !== "--") {
        connectionName = value;
      }
      if (key.startsWith("IP4.ADDRESS") && value) {
        // Strip CIDR suffix (e.g. "192.168.1.100/24" -> "192.168.1.100")
        ip = value.split("/")[0];
      }
    }

    // Resolve the actual SSID from the connection profile
    // (NetworkManager/netplan may use a profile name different from the SSID)
    if (connectionName && connectionName !== AP_CON_NAME) {
      try {
        const ssidOutput = await nmcli("-t", "-f", "802-11-wireless.ssid", "connection", "show", connectionName);
        const ssidLine = ssidOutput.split("\n").find((l) => l.startsWith("802-11-wireless.ssid:"));
        if (ssidLine) {
          ssid = ssidLine.split(":").slice(1).join(":");
        }
      } catch {
        // Fallback to connection name
        ssid = connectionName;
      }
    }
    if (!ssid && connectionName) {
      ssid = connectionName;
    }

    // If hotspot is active, report the hotspot SSID
    if (hotspotActive) {
      ssid = AP_SSID;
    }

    return { connected, ssid, ip, hotspotActive };
  } catch (err: any) {
    console.error("[WiFi] Failed to get status:", err.message);
    return { connected: false, ssid: null, ip: null, hotspotActive: false };
  }
}

/**
 * Scan for available WiFi networks.
 * Triggers a fresh scan and returns deduplicated results.
 */
export async function scanNetworks(): Promise<WifiNetwork[]> {
  if (devMode) {
    return [
      { ssid: "HomeNetwork", signal: 85, security: "WPA2", active: true },
      { ssid: "Neighbor-5G", signal: 42, security: "WPA2", active: false },
      { ssid: "CoffeeShop", signal: 60, security: "Open", active: false },
    ];
  }

  try {
    // Trigger a fresh scan (ignore errors — scan may already be in progress)
    await nmcli("device", "wifi", "rescan").catch(() => {});

    // Small delay to let the scan complete
    await new Promise((r) => setTimeout(r, 1000));

    // Get network list
    const output = await nmcli("-t", "-f", "SSID,SIGNAL,SECURITY,ACTIVE", "device", "wifi", "list");
    const lines = output.split("\n").filter((l) => l.trim());

    const networkMap = new Map<string, WifiNetwork>();

    for (const line of lines) {
      // nmcli -t uses ":" as separator, but SSID can contain colons
      // Format: SSID:SIGNAL:SECURITY:ACTIVE
      // Parse from the end since SSID may contain ":"
      const parts = line.split(":");
      if (parts.length < 4) continue;

      const active = parts.pop() === "yes";
      const security = parts.pop() || "";
      const signal = parseInt(parts.pop() || "0", 10);
      const ssid = parts.join(":"); // Rejoin in case SSID had colons

      if (!ssid) continue; // Skip hidden networks

      // Deduplicate — keep the one with strongest signal, but preserve active flag
      const existing = networkMap.get(ssid);
      if (!existing || existing.signal < signal) {
        networkMap.set(ssid, {
          ssid,
          signal,
          security: security || "Open",
          active: active || (existing?.active ?? false),
        });
      } else if (active && !existing.active) {
        existing.active = true;
      }
    }

    // Sort by signal strength descending
    return Array.from(networkMap.values()).sort((a, b) => b.signal - a.signal);
  } catch (err: any) {
    console.error("[WiFi] Failed to scan networks:", err.message);
    return [];
  }
}

/**
 * Connect to a WiFi network. On success, stops the hotspot if active.
 */
export async function connectToNetwork(
  ssid: string,
  password: string
): Promise<{ success: boolean; error?: string }> {
  if (devMode) {
    return { success: true };
  }

  try {
    console.log(`[WiFi] Connecting to "${ssid}"...`);

    // If hotspot is active, bring it down first — can't connect while in AP mode
    const hotspot = await isHotspotActive();
    if (hotspot) {
      console.log("[WiFi] Stopping hotspot before connecting...");
      await stopHotspot();
      // Wait for adapter to settle
      await new Promise((r) => setTimeout(r, 2000));
    }

    // Try to connect
    if (password) {
      await nmcli("device", "wifi", "connect", ssid, "password", password, "ifname", "wlan0");
    } else {
      await nmcli("device", "wifi", "connect", ssid, "ifname", "wlan0");
    }

    console.log(`[WiFi] Connected to "${ssid}"`);
    // Network is now available — retry playback if a channel was selected
    // but couldn't play (e.g. hotspot mode had no internet)
    radioState.retryPlayback();
    return { success: true };
  } catch (err: any) {
    console.error(`[WiFi] Failed to connect to "${ssid}":`, err.message);

    // If connection failed and we took down the hotspot, restart it
    // so the user can still reach the config page
    try {
      const status = await getWifiStatus();
      if (!status.connected) {
        console.log("[WiFi] Connection failed — restarting hotspot...");
        await startHotspot();
      }
    } catch {
      // Best effort
    }

    // Extract a human-readable error from the nmcli output
    let error = "Connection failed";
    if (err.message.includes("Secrets were required")) {
      error = "Incorrect password";
    } else if (err.message.includes("No network with SSID")) {
      error = "Network not found";
    } else if (err.message.includes("timed out")) {
      error = "Connection timed out";
    }

    return { success: false, error };
  }
}

/**
 * Start the WiFi hotspot (access point mode).
 * Uses an open AP (no password) — WPA-PSK fails on Pi 3 BCM43430 firmware.
 */
export async function startHotspot(): Promise<void> {
  if (devMode) return;

  try {
    console.log(`[WiFi] Starting hotspot "${AP_SSID}" (open)...`);
    // Delete any stale profile first
    await nmcli("connection", "delete", AP_CON_NAME).catch(() => {});
    // Create open AP profile
    await nmcli(
      "connection", "add",
      "type", "wifi",
      "con-name", AP_CON_NAME,
      "ifname", "wlan0",
      "ssid", AP_SSID,
      "autoconnect", "no",
      "wifi.mode", "ap",
      "wifi.band", "bg",
      "wifi.channel", "6",
      "ipv4.method", "shared",
      "ipv4.addresses", "10.42.0.1/24"
    );
    // Activate it
    await nmcli("connection", "up", AP_CON_NAME);
    console.log(`[WiFi] Hotspot active — SSID: ${AP_SSID} (open, no password)`);
  } catch (err: any) {
    console.error("[WiFi] Failed to start hotspot:", err.message);
    throw err;
  }
}

/**
 * Stop the WiFi hotspot and clean up the connection profile.
 */
export async function stopHotspot(): Promise<void> {
  if (devMode) return;

  try {
    // Bring down the hotspot connection
    await nmcli("connection", "down", AP_CON_NAME).catch(() => {});
    // Delete the connection profile to avoid stale profiles accumulating
    await nmcli("connection", "delete", AP_CON_NAME).catch(() => {});
    console.log("[WiFi] Hotspot stopped");
  } catch (err: any) {
    console.error("[WiFi] Failed to stop hotspot:", err.message);
  }
}

/**
 * Check if the hotspot is currently active.
 * Uses `nmcli device status` which reliably shows the connection name
 * associated with wlan0 regardless of whether any client is connected.
 */
export async function isHotspotActive(): Promise<boolean> {
  if (devMode) return false;

  try {
    // nmcli -t device status outputs lines like:
    // wlan0:wifi:connected:radionette-hotspot
    // wlan0:wifi:connected:MyNetwork
    // wlan0:wifi:disconnected:--
    const output = await nmcli("-t", "device", "status");
    const lines = output.split("\n");
    for (const line of lines) {
      const parts = line.split(":");
      // parts: [DEVICE, TYPE, STATE, CONNECTION]
      if (parts[0] === "wlan0" && parts[3] === AP_CON_NAME) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Delete all WiFi connection profiles (except loopback and ethernet).
 * After reboot, the Pi will have no known networks and the wifi-fallback
 * service will start the Radionette-Setup hotspot.
 */
export async function resetWifiConfig(): Promise<{ success: boolean; deleted: string[]; error?: string }> {
  if (devMode) {
    return { success: true, deleted: ["DevNetwork (mock)"] };
  }

  try {
    // List all connections
    const output = await nmcli("-t", "-f", "NAME,TYPE", "connection", "show");
    const lines = output.split("\n").filter((l) => l.trim());
    const deleted: string[] = [];

    for (const line of lines) {
      const [name, type] = line.split(":");
      if (!name || !type) continue;
      // Only delete wifi connections
      if (type !== "802-11-wireless") continue;
      try {
        await nmcli("connection", "delete", name);
        deleted.push(name);
        console.log(`[WiFi] Deleted connection profile: ${name}`);
      } catch (err: any) {
        console.error(`[WiFi] Failed to delete "${name}":`, err.message);
      }
    }

    console.log(`[WiFi] Reset complete — deleted ${deleted.length} profile(s)`);
    return { success: true, deleted };
  } catch (err: any) {
    console.error("[WiFi] Failed to reset config:", err.message);
    return { success: false, deleted: [], error: err.message };
  }
}

/**
 * Reboot the system via systemctl.
 * Responds immediately — the reboot happens asynchronously.
 */
export async function rebootSystem(): Promise<{ success: boolean; error?: string }> {
  if (devMode) {
    console.log("[System] Reboot requested (dev mode — skipping)");
    return { success: true };
  }

  try {
    console.log("[System] Reboot requested — rebooting in 1 second...");
    // Use a small delay so the HTTP response can be sent before the system goes down
    setTimeout(() => {
      execFile(SYSTEMCTL, ["reboot"], (err) => {
        if (err) console.error("[System] Reboot failed:", err.message);
      });
    }, 1000);
    return { success: true };
  } catch (err: any) {
    console.error("[System] Reboot failed:", err.message);
    return { success: false, error: err.message };
  }
}

export function initWifi(): void {
  console.log("[WiFi] Initialized, endpoints available at /wifi and /api/wifi/*");
}
