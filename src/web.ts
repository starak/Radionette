import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { WebSocketServer, WebSocket } from "ws";
import { radioState, RadioState } from "./state";
import {
  getAllChannels,
  getAllBands,
  getChannelsConfig,
  saveChannelsConfig,
  validateChannelsConfig,
  getBandMapping,
  saveBandMapping,
  validateBandMapping,
  channelById,
} from "./channels";
import { getWifiStatus, scanNetworks, connectToNetwork, resetWifiConfig, rebootSystem } from "./wifi";
import { injectGpioValue, resetGpioOverride } from "./gpio";
import { setLogoOverride, getLogoOverride, setDisplayTint, getDisplayTint } from "./display-service";
import { setVolumeSoftware, resetVolumeToPhysical } from "./volume";
import { calibrateTuner, invertTuner, tunerStatus, setTunerChannelOverride } from "./tuner";
import {
  getDisplayOptions,
  getDisplayMapping,
  clearDisplayMapping,
  saveDisplayMapping,
  validateDisplayMapping,
} from "./display-settings";
import {
  getDisplayPreferences,
  saveDefaultTint,
  validateDisplayPreferences,
} from "./display-preferences";
import {
  changeSettingsPin,
  createSettingsSession,
  deleteSettingsSession,
  settingsSessionMaxAgeSeconds,
  verifySettingsPin,
  verifySettingsSession,
} from "./settings-security";
import {
  getSpotifyBandOrdinal,
  getSpotifySettingsStatus,
  saveSpotifyApiKey,
  saveSpotifyBandOrdinal,
} from "./spotify-settings";
import { restartSpotifyConnect } from "./spotify-connect";

const PORT = 8080;

let wss: WebSocketServer | null = null;
let server: http.Server | null = null;
const SETTINGS_COOKIE = "radionette_settings";
const loginFailures = new Map<string, { count: number; blockedUntil: number }>();

function loginClientKey(req: http.IncomingMessage): string {
  return req.socket.remoteAddress || "unknown";
}

function loginBlocked(req: http.IncomingMessage): number {
  const state = loginFailures.get(loginClientKey(req));
  if (!state || state.blockedUntil <= Date.now()) return 0;
  return Math.ceil((state.blockedUntil - Date.now()) / 1000);
}

function recordLoginFailure(req: http.IncomingMessage): void {
  const key = loginClientKey(req);
  const current = loginFailures.get(key);
  const count = current?.blockedUntil && current.blockedUntil <= Date.now()
    ? 1
    : (current?.count || 0) + 1;
  loginFailures.set(key, {
    count,
    blockedUntil: count >= 5 ? Date.now() + 60_000 : 0,
  });
}

function getCookie(req: http.IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie || "";
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

function settingsToken(req: http.IncomingMessage): string | undefined {
  return getCookie(req, SETTINGS_COOKIE);
}

function settingsAuthenticated(req: http.IncomingMessage): boolean {
  return verifySettingsSession(settingsToken(req));
}

function sessionCookie(token: string): string {
  return `${SETTINGS_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${settingsSessionMaxAgeSeconds()}`;
}

function clearSessionCookie(): string {
  return `${SETTINGS_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}

function sendJson(res: http.ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
}

function readJsonBody(req: http.IncomingMessage, maxBytes = 2_000_000): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > maxBytes) {
        reject(new Error("Request body is too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try { resolve(JSON.parse(body || "{}")); }
      catch { reject(new Error("Invalid JSON")); }
    });
    req.on("error", reject);
  });
}

function getSettingsBundle(): object {
  return {
    version: 1,
    channels: getChannelsConfig(),
    bandMapping: getBandMapping(),
    displayMapping: getDisplayMapping(),
    displayPreferences: getDisplayPreferences(),
    spotify: getSpotifySettingsStatus(),
    rawGpio: radioState.state.rawGpio,
  };
}

function getStatusPayload(): string {
  return JSON.stringify({
    type: "state",
    ...radioState.state,
    bands: getAllBands(),
    channels: getAllChannels(),
    logoOverride: getLogoOverride(),
    displayTint: getDisplayTint(),
    displayOptions: getDisplayOptions(),
    tuner: tunerStatus(),
    spotifyBand: getSpotifyBandOrdinal(),
  });
}

function broadcast(data: string): void {
  if (!wss) return;
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

export function startWebServer(): void {
  // Resolve the HTML file path
  // In dist, public/ sits next to the JS files
  const publicDir = path.resolve(__dirname, "public");
  const serveFrontend = (res: http.ServerResponse): void => {
    fs.readFile(path.join(publicDir, "index.html"), "utf-8", (err, data) => {
      if (err) { res.writeHead(500, { "Content-Type": "text/plain" }); res.end("Frontend is not built"); return; }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
      res.end(data);
    });
  };

  server = http.createServer(async (req, res) => {
    if (req.url?.startsWith("/assets/")) {
      const requested = decodeURIComponent(req.url.slice("/assets/".length));
      const filename = path.basename(requested);
      if (!filename || requested !== filename) { res.writeHead(400); res.end(); return; }
      fs.readFile(path.join(publicDir, "assets", filename), (err, data) => {
        if (err) { res.writeHead(404); res.end(); return; }
        const ext = path.extname(filename);
        const type = ext === ".css" ? "text/css; charset=utf-8" : ext === ".js" ? "text/javascript; charset=utf-8" : "application/octet-stream";
        res.writeHead(200, { "Content-Type": type, "Cache-Control": "public, max-age=31536000, immutable" });
        res.end(data);
      });
      return;
    }

    if (req.url?.startsWith("/logos/")) {
      const requested = decodeURIComponent(req.url.slice("/logos/".length));
      const filename = path.basename(requested);
      if (!filename || filename !== requested) { res.writeHead(400); res.end(); return; }
      const logoPath = path.resolve(process.cwd(), "assets", "channel-logos", filename);
      fs.readFile(logoPath, (err, data) => {
        if (err) { res.writeHead(404); res.end(); return; }
        const ext = path.extname(filename).toLowerCase();
        const type = ext === ".gif" ? "image/gif" : ext === ".svg" ? "image/svg+xml" : "image/png";
        res.writeHead(200, { "Content-Type": type, "Cache-Control": "public, max-age=3600" });
        res.end(data);
      });
      return;
    }

    if (req.url === "/" || req.url === "/index.html") {
      serveFrontend(res);
      return;
    }

    if (req.url === "/api/status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(getStatusPayload());
      return;
    }

    if (req.url === "/api/channels") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(getAllChannels()));
      return;
    }

    if (req.url === "/debug" || req.url === "/debug.html") {
      serveFrontend(res);
      return;
    }

    if (req.url === "/settings/login" && req.method === "GET") {
      if (settingsAuthenticated(req)) {
        res.writeHead(302, { Location: "/settings" });
        res.end();
        return;
      }
      serveFrontend(res);
      return;
    }

    if (req.url === "/api/settings/login" && req.method === "POST") {
      try {
        const retryAfter = loginBlocked(req);
        if (retryAfter) {
          res.writeHead(429, {
            "Content-Type": "application/json",
            "Retry-After": String(retryAfter),
          });
          res.end(JSON.stringify({ success: false, error: `Too many attempts; try again in ${retryAfter} seconds` }));
          return;
        }
        const { pin } = await readJsonBody(req, 10_000);
        if (!verifySettingsPin(pin)) {
          recordLoginFailure(req);
          sendJson(res, 401, { success: false, error: "Incorrect PIN" });
          return;
        }
        loginFailures.delete(loginClientKey(req));
        const token = createSettingsSession();
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Set-Cookie": sessionCookie(token),
        });
        res.end(JSON.stringify({ success: true }));
      } catch (err: any) {
        sendJson(res, 400, { success: false, error: err.message });
      }
      return;
    }

    if (req.url === "/api/settings/logout" && req.method === "POST") {
      deleteSettingsSession(settingsToken(req));
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Set-Cookie": clearSessionCookie(),
      });
      res.end(JSON.stringify({ success: true }));
      return;
    }

    if (req.url === "/settings" || req.url === "/settings.html") {
      if (!settingsAuthenticated(req)) {
        res.writeHead(302, { Location: "/settings/login" });
        res.end();
        return;
      }
      serveFrontend(res);
      return;
    }

    // --- Persistent per-radio settings ---

    if (req.url?.startsWith("/api/settings") && !settingsAuthenticated(req)) {
      sendJson(res, 401, { success: false, error: "Settings PIN required" });
      return;
    }

    if (req.url === "/api/settings/pin" && req.method === "PUT") {
      try {
        const { currentPin, newPin } = await readJsonBody(req, 10_000);
        changeSettingsPin(currentPin, newPin);
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Set-Cookie": clearSessionCookie(),
        });
        res.end(JSON.stringify({ success: true, loginRequired: true }));
      } catch (err: any) {
        sendJson(res, 400, { success: false, error: err.message });
      }
      return;
    }

    if (req.url === "/api/settings" && req.method === "GET") {
      sendJson(res, 200, getSettingsBundle());
      return;
    }

    if (req.url === "/api/settings/export" && req.method === "GET") {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="radionette-settings-${new Date().toISOString().slice(0, 10)}.json"`,
      });
      res.end(`${JSON.stringify(getSettingsBundle(), null, 2)}\n`);
      return;
    }

    if (req.url === "/api/settings/channels" && req.method === "PUT") {
      try {
        const value = await readJsonBody(req);
        const saved = saveChannelsConfig(value);
        resetGpioOverride();
        broadcast(getStatusPayload());
        sendJson(res, 200, { success: true, channels: saved });
      } catch (err: any) {
        sendJson(res, 400, { success: false, error: err.message });
      }
      return;
    }

    if (req.url === "/api/settings/band-mapping" && req.method === "PUT") {
      try {
        const value = await readJsonBody(req);
        const saved = saveBandMapping(value);
        resetGpioOverride();
        broadcast(getStatusPayload());
        sendJson(res, 200, { success: true, bandMapping: saved });
      } catch (err: any) {
        sendJson(res, 400, { success: false, error: err.message });
      }
      return;
    }

    if (req.url === "/api/settings/display-mapping" && req.method === "PUT") {
      try {
        const value = await readJsonBody(req);
        const saved = saveDisplayMapping(value);
        resetGpioOverride();
        broadcast(getStatusPayload());
        sendJson(res, 200, { success: true, displayMapping: saved });
      } catch (err: any) {
        sendJson(res, 400, { success: false, error: err.message });
      }
      return;
    }

    if (req.url === "/api/settings/tint" && req.method === "PUT") {
      try {
        const value = await readJsonBody(req);
        const tint = saveDefaultTint(value);
        await setDisplayTint(tint);
        broadcast(getStatusPayload());
        sendJson(res, 200, { success: true, tint });
      } catch (err: any) {
        sendJson(res, 400, { success: false, error: err.message });
      }
      return;
    }

    if (req.url === "/api/settings/spotify" && req.method === "PUT") {
      try {
        const { apiKey, bandOrdinal } = await readJsonBody(req, 10_000);
        let spotify = getSpotifySettingsStatus();
        if (bandOrdinal !== undefined) {
          if (!getAllBands().some((band) => band.ordinal === bandOrdinal)) {
            throw new Error(`Unknown Spotify band ${bandOrdinal}`);
          }
        }
        if (typeof apiKey === "string" && apiKey.trim()) spotify = saveSpotifyApiKey(apiKey);
        if (bandOrdinal !== undefined) {
          spotify = saveSpotifyBandOrdinal(bandOrdinal);
        }
        restartSpotifyConnect();
        sendJson(res, 200, { success: true, spotify });
      } catch (err: any) {
        sendJson(res, 400, { success: false, error: err.message });
      }
      return;
    }

    if (req.url === "/api/settings/import" && req.method === "POST") {
      try {
        const value = await readJsonBody(req);
        if (value.version !== 1) throw new Error("Unsupported settings backup version");
        // Validate the entire backup before writing any file.
        const channels = validateChannelsConfig(value.channels);
        const bandMapping = validateBandMapping(value.bandMapping, channels.bands);
        const displayMapping = value.displayMapping === null
          ? null
          : validateDisplayMapping(value.displayMapping);
        const preferences = validateDisplayPreferences(value.displayPreferences);
        const requestedSpotifyBand = value.spotify?.bandOrdinal;
        const currentSpotifyBand = getSpotifyBandOrdinal();
        const spotifyBand =
          requestedSpotifyBand ??
          (channels.bands.some((band) => band.ordinal === currentSpotifyBand)
            ? currentSpotifyBand
            : channels.bands.some((band) => band.ordinal === 4)
              ? 4
              : channels.bands[channels.bands.length - 1]?.ordinal);
        if (!channels.bands.some((band) => band.ordinal === spotifyBand)) {
          throw new Error(`Spotify band ${spotifyBand} is not present in the imported bands`);
        }
        saveChannelsConfig(channels);
        saveBandMapping(bandMapping);
        if (displayMapping) saveDisplayMapping(displayMapping);
        else clearDisplayMapping();
        const tint = saveDefaultTint(preferences);
        saveSpotifyBandOrdinal(spotifyBand);
        await setDisplayTint(tint);
        restartSpotifyConnect();
        resetGpioOverride();
        broadcast(getStatusPayload());
        sendJson(res, 200, { success: true, settings: getSettingsBundle() });
      } catch (err: any) {
        sendJson(res, 400, { success: false, error: err.message });
      }
      return;
    }

    // --- WiFi routes ---

    if (req.url === "/wifi" || req.url === "/wifi.html") {
      serveFrontend(res);
      return;
    }

    if (req.url === "/api/wifi/status" && req.method === "GET") {
      try {
        const status = await getWifiStatus();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(status));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (req.url === "/api/wifi/scan" && req.method === "GET") {
      try {
        const networks = await scanNetworks();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(networks));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (req.url === "/api/wifi/connect" && req.method === "POST") {
      // Read JSON body manually (no Express)
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", async () => {
        try {
          const { ssid, password } = JSON.parse(body);
          if (!ssid || typeof ssid !== "string") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: "Missing SSID" }));
            return;
          }
          const result = await connectToNetwork(ssid, password || "");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (err: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, error: err.message }));
        }
      });
      return;
    }

    if (req.url === "/api/debug/gpio" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        try {
          const { value } = JSON.parse(body);
          if (typeof value !== "number" || value < 0 || value > 2047 || !Number.isInteger(value)) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: "value must be an integer 0-2047" }));
            return;
          }
          injectGpioValue(value);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true, value }));
        } catch (err: any) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, error: "Invalid JSON" }));
        }
      });
      return;
    }

    if (req.url === "/api/debug/gpio/reset" && req.method === "POST") {
      resetGpioOverride();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true }));
      return;
    }

    if (req.url === "/api/debug/reset" && req.method === "POST") {
      try {
        resetGpioOverride();
        setTunerChannelOverride(null);
        setLogoOverride(null);
        await resetVolumeToPhysical();
        await setDisplayTint(getDisplayPreferences().tint);
        broadcast(getStatusPayload());
        sendJson(res, 200, { success: true });
      } catch (err: any) {
        sendJson(res, 500, { success: false, error: err.message });
      }
      return;
    }

    if (req.url === "/api/debug/channel" && req.method === "POST") {
      try {
        const { id } = await readJsonBody(req, 10_000);
        if (id === null) {
          setTunerChannelOverride(null);
          sendJson(res, 200, { success: true, id: null });
          return;
        }
        if (typeof id !== "string") throw new Error("id must be a channel id or null");
        const channel = channelById(id);
        if (!channel) throw new Error(`Unknown channel: ${id}`);
        if (!radioState.state.power || radioState.state.mode !== "radio") {
          throw new Error("Radio must be powered on in radio mode");
        }
        setTunerChannelOverride(channel);
        sendJson(res, 200, { success: true, id });
      } catch (err: any) {
        sendJson(res, 400, { success: false, error: err.message });
      }
      return;
    }

    if (req.url === "/api/debug/volume" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", async () => {
        try {
          const { volume } = JSON.parse(body);
          if (typeof volume !== "number" || volume < 0 || volume > 100) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: "volume must be a number 0-100" }));
            return;
          }
          await setVolumeSoftware(volume);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true, volume }));
        } catch (err: any) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, error: err.message || "Invalid JSON" }));
        }
      });
      return;
    }

    if (req.url === "/api/debug/logo-override" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        try {
          const { ref } = JSON.parse(body);
          if (ref !== null && typeof ref !== "string") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: "ref must be a string or null" }));
            return;
          }
          setLogoOverride(ref);
          // State didn't actually change so radioState won't broadcast — push
          // a manual update so connected clients see the new logoOverride flag.
          broadcast(getStatusPayload());
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true, ref }));
        } catch (err: any) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, error: "Invalid JSON" }));
        }
      });
      return;
    }

    if (req.url === "/api/debug/tint" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", async () => {
        try {
          const { r, g, b } = JSON.parse(body);
          const validate = (v: any, name: string) => {
            if (v === undefined) return;
            if (typeof v !== "number" || !isFinite(v) || v < 0 || v > 2) {
              throw new Error(`${name} must be a number 0..2`);
            }
          };
          validate(r, "r"); validate(g, "g"); validate(b, "b");
          await setDisplayTint({ r, g, b });
          broadcast(getStatusPayload());
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true, tint: getDisplayTint() }));
        } catch (err: any) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, error: err.message || "Invalid JSON" }));
        }
      });
      return;
    }

    if (req.url === "/api/system/wifi-reset" && req.method === "POST") {
      try {
        const result = await resetWifiConfig();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
      return;
    }

    if (req.url === "/api/system/reboot" && req.method === "POST") {
      try {
        const result = await rebootSystem();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
      return;
    }

    if (req.url === "/api/tuner" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(tunerStatus()));
      return;
    }

    if (req.url === "/api/tuner/calibrate" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        try {
          const { kind } = JSON.parse(body);
          if (kind !== "min" && kind !== "max") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: "kind must be 'min' or 'max'" }));
            return;
          }
          const captured = calibrateTuner(kind);
          if (captured === null) {
            res.writeHead(503, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: "Tuner unavailable" }));
            return;
          }
          broadcast(getStatusPayload());
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true, kind, raw: captured, tuner: tunerStatus() }));
        } catch (err: any) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, error: err.message || "Invalid JSON" }));
        }
      });
      return;
    }

    if (req.url === "/api/tuner/invert" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        try {
          const { invert } = JSON.parse(body);
          if (typeof invert !== "boolean") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: "invert must be a boolean" }));
            return;
          }
          invertTuner(invert);
          broadcast(getStatusPayload());
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true, invert, tuner: tunerStatus() }));
        } catch (err: any) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, error: err.message || "Invalid JSON" }));
        }
      });
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  });

  // WebSocket server on the same HTTP server
  wss = new WebSocketServer({ server });

  wss.on("connection", (ws) => {
    console.log("[Web] WebSocket client connected");
    // Send current state immediately on connect
    ws.send(getStatusPayload());

    ws.on("close", () => {
      console.log("[Web] WebSocket client disconnected");
    });
  });

  // Broadcast state changes to all connected clients
  radioState.on("state:change", (_state: RadioState) => {
    broadcast(getStatusPayload());
  });

  server.listen(PORT, () => {
    console.log(`[Web] Status page at http://localhost:${PORT}/`);
    console.log(`[Web] WebSocket on ws://localhost:${PORT}/`);
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    console.error(`[Web] Server error:`, err);
  });
}

export function stopWebServer(): Promise<void> {
  return new Promise((resolve) => {
    if (wss) {
      for (const client of wss.clients) {
        client.close();
      }
      wss.close();
      wss = null;
    }
    if (server) {
      server.close(() => {
        console.log("[Web] Server stopped.");
        resolve();
      });
    } else {
      resolve();
    }
  });
}
