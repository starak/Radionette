import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { WebSocketServer, WebSocket } from "ws";
import { radioState, RadioState } from "./state";
import { getAllChannels } from "./channels";
import { getWifiStatus, scanNetworks, connectToNetwork, resetWifiConfig, rebootSystem } from "./wifi";

const PORT = 80;

let wss: WebSocketServer | null = null;
let server: http.Server | null = null;

function getStatusPayload(): string {
  return JSON.stringify({
    type: "state",
    ...radioState.state,
    channels: getAllChannels(),
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

  server = http.createServer(async (req, res) => {
    if (req.url === "/" || req.url === "/index.html") {
      const htmlPath = path.join(publicDir, "index.html");
      fs.readFile(htmlPath, "utf-8", (err, data) => {
        if (err) {
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end("Failed to load status page");
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(data);
      });
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
      const htmlPath = path.join(publicDir, "debug.html");
      fs.readFile(htmlPath, "utf-8", (err, data) => {
        if (err) {
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end("Failed to load debug page");
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(data);
      });
      return;
    }

    // --- WiFi routes ---

    if (req.url === "/wifi" || req.url === "/wifi.html") {
      const htmlPath = path.join(publicDir, "wifi.html");
      fs.readFile(htmlPath, "utf-8", (err, data) => {
        if (err) {
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end("Failed to load WiFi settings page");
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(data);
      });
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
    if (err.code === "EACCES") {
      console.error(
        `[Web] Permission denied on port ${PORT}. Run with sudo or use authbind.`
      );
    } else {
      console.error(`[Web] Server error:`, err);
    }
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
