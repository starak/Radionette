import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { WebSocketServer, WebSocket } from "ws";
import { radioState, RadioState } from "./state";
import { getAllChannels } from "./channels";

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

  server = http.createServer((req, res) => {
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
