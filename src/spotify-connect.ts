import { ChildProcess, spawn } from "child_process";
import WebSocket from "ws";
import { radionetteConfigPath } from "./config-storage";
import { radioState, SpotifyQueueItem } from "./state";
import { getSpotifyApiKey } from "./spotify-settings";

/** Logical Band 4 is reserved for the Spotify Connect input. */
export const SPOTIFY_BAND_ORDINAL = 4;

const COMMAND = process.env.RADIONETTE_SPOTIFY_COMMAND || "/usr/local/bin/soloist";
const DATA_DIR = process.env.RADIONETTE_SPOTIFY_DATA_DIR || radionetteConfigPath("soloist");
const CACHE_DIR = process.env.RADIONETTE_SPOTIFY_CACHE_DIR || radionetteConfigPath("soloist-cache");
const RETRY_MS = 30000;
const WS_URL = "ws://127.0.0.1:9878";

let processHandle: ChildProcess | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let initialized = false;
let stopping = false;
let missingKeyReported = false;
let soloistSocket: WebSocket | null = null;
let socketRetryTimer: ReturnType<typeof setTimeout> | null = null;
let lastSoloistVolume: number | null = null;
const volumeListeners = new Set<(volume: number) => void>();
let spotifyPlaybackStatus = "idle";
let spotifyPlaybackItem: any = null;

function entityName(entity: any): string {
  return typeof entity?.decorations?.identity?.name === "string"
    ? entity.decorations.identity.name.trim()
    : "";
}

function entityCreators(entity: any): string {
  const creators = Array.isArray(entity?.decorations?.creators)
    ? entity.decorations.creators
        .map((creator: any) => entityName(creator?.entity))
        .filter(Boolean)
    : [];
  return creators.join(", ") || entityName(entity?.decorations?.parent?.entity) || "Spotify";
}

function entityCover(entity: any): string | null {
  const covers = Array.isArray(entity?.decorations?.visual_identity?.cover)
    ? entity.decorations.visual_identity.cover
    : [];
  const cover =
    covers.find((item: any) => item?.size === "xlarge") ||
    covers.find((item: any) => item?.size === "large") ||
    covers.find((item: any) => item?.size === "default") ||
    covers[0];
  return typeof cover?.url === "string" && cover.url ? cover.url : null;
}

function requestSpotifyQueue(): void {
  if (!soloistSocket || soloistSocket.readyState !== WebSocket.OPEN) return;
  soloistSocket.send(JSON.stringify({ type: "command", command: "get_queue", limit: 30 }));
}

function updateSpotifyQueue(entries: any): void {
  if (!Array.isArray(entries)) return;
  const occurrences = new Map<string, number>();
  const queue: SpotifyQueueItem[] = entries.map((entry: any, index: number) => {
    const item = entry?.item || {};
    const baseUid = String(entry?.uid || item?.uri || index);
    const occurrence = occurrences.get(baseUid) || 0;
    occurrences.set(baseUid, occurrence + 1);
    return {
      uid: occurrence === 0 ? baseUid : `${baseUid}#${occurrence}`,
      uri: typeof item?.uri === "string" ? item.uri : "",
      title: entityName(item) || "Unknown item",
      artist: entityCreators(item),
      artworkUrl: entityCover(item),
      source: typeof entry?.source === "string" ? entry.source : "context",
    };
  });
  radioState.setSpotifyQueue(queue);
}

function updateSpotifyPresentation(): void {
  if (!shouldRun() || !spotifyPlaybackItem) {
    radioState.setExternalPlayback(false, null, null);
    return;
  }

  const title = entityName(spotifyPlaybackItem);
  const artist = entityCreators(spotifyPlaybackItem);
  const coverUrl = entityCover(spotifyPlaybackItem);
  const artwork =
    title && coverUrl
      ? { url: coverUrl, artist, title }
      : null;
  const metadata = title ? (artist ? `${artist} — ${title}` : title) : null;
  radioState.setExternalPlayback(spotifyPlaybackStatus === "playing", metadata, artwork);
}

function handleSoloistMessage(message: any): void {
  if (message.type === "volume_changed") {
    publishSoloistVolume(message.volume);
  } else if (message.type === "playback_state") {
    publishSoloistVolume(message.volume);
    spotifyPlaybackStatus = typeof message.status === "string" ? message.status : "idle";
    spotifyPlaybackItem = message.item || null;
    updateSpotifyPresentation();
    requestSpotifyQueue();
  } else if (message.type === "track_changed") {
    spotifyPlaybackItem = message.item || null;
    updateSpotifyPresentation();
  } else if (message.type === "playback_changed") {
    spotifyPlaybackStatus = typeof message.status === "string" ? message.status : "idle";
    updateSpotifyPresentation();
  } else if (message.type === "device_changed" && message.is_active === false) {
    spotifyPlaybackStatus = "idle";
    updateSpotifyPresentation();
  } else if (message.type === "auth_state" && message.logged_in === true) {
    requestSpotifyQueue();
  } else if (message.type === "queue_changed") {
    updateSpotifyQueue(message.upcoming);
  }
}

function closeSoloistSocket(): void {
  if (socketRetryTimer) clearTimeout(socketRetryTimer);
  socketRetryTimer = null;
  const socket = soloistSocket;
  soloistSocket = null;
  if (socket) socket.close();
}

function scheduleSocketConnect(): void {
  if (socketRetryTimer || !processHandle || stopping) return;
  socketRetryTimer = setTimeout(() => {
    socketRetryTimer = null;
    connectSoloistSocket();
  }, 500);
}

function publishSoloistVolume(value: unknown): void {
  if (typeof value !== "number" || !Number.isFinite(value)) return;
  const volume = Math.max(0, Math.min(100, Math.round(value)));
  lastSoloistVolume = volume;
  for (const listener of volumeListeners) listener(volume);
}

function connectSoloistSocket(): void {
  if (!processHandle || stopping || soloistSocket) return;
  const socket = new WebSocket(WS_URL);
  soloistSocket = socket;
  socket.on("open", () => {
    socket.send(JSON.stringify({ type: "command", command: "get_state" }));
  });
  socket.on("message", (data) => {
    try {
      const message = JSON.parse(data.toString());
      handleSoloistMessage(message);
    } catch {
      // Ignore malformed/unknown Soloist events; the connection stays usable.
    }
  });
  socket.on("error", () => {
    // Startup commonly races the WebSocket listener. close schedules retry.
  });
  socket.on("close", () => {
    if (soloistSocket === socket) soloistSocket = null;
    scheduleSocketConnect();
  });
}

function shouldRun(): boolean {
  const state = radioState.state;
  return state.power && state.mode === "radio" && state.selectedBand === SPOTIFY_BAND_ORDINAL;
}

function clearRetry(): void {
  if (!retryTimer) return;
  clearTimeout(retryTimer);
  retryTimer = null;
}

function scheduleRetry(): void {
  if (retryTimer || stopping || !shouldRun()) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    reconcile();
  }, RETRY_MS);
}

function start(): void {
  if (processHandle || stopping || !shouldRun()) return;

  const apiKey = getSpotifyApiKey();
  if (!apiKey) {
    if (!missingKeyReported) {
      console.warn("[Spotify] Band 4 selected, but no Soloist API key is configured in Settings");
      missingKeyReported = true;
    }
    return;
  }
  missingKeyReported = false;

  console.log("[Spotify] Band 4 selected — starting official Spotify Soloist speaker ‘Radionette’");
  const child = spawn(COMMAND, [
    "--device-name", "Radionette",
    "--api-key", apiKey,
    "--data-dir", DATA_DIR,
    "--cache-dir", CACHE_DIR,
    "--ws", "127.0.0.1:9878",
  ], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  processHandle = child;
  scheduleSocketConnect();

  child.once("error", (err) => {
    if (child !== processHandle) return;
    processHandle = null;
    closeSoloistSocket();
    console.error(`[Spotify] Could not start ${COMMAND}: ${err.message}`);
    scheduleRetry();
  });

  child.once("exit", (code, signal) => {
    if (child !== processHandle) return;
    processHandle = null;
    closeSoloistSocket();
    if (code === 10) {
      console.error("[Spotify] Soloist build expired — rerun setup-pi.sh to install the current build");
    } else if (shouldRun() && !stopping) {
      console.error(`[Spotify] Connect speaker exited (code=${code}, signal=${signal}); retrying`);
      scheduleRetry();
    } else {
      console.log("[Spotify] Connect speaker stopped");
    }
  });
}

function stop(): void {
  clearRetry();
  closeSoloistSocket();
  spotifyPlaybackStatus = "idle";
  spotifyPlaybackItem = null;
  radioState.setExternalPlayback(false, null, null);
  radioState.setSpotifyQueue([]);
  const child = processHandle;
  if (!child) return;
  processHandle = null;
  console.log("[Spotify] Leaving Band 4 — stopping Connect speaker");
  try {
    child.kill("SIGTERM");
  } catch {
    // Process already exited.
  }
}

function reconcile(): void {
  if (shouldRun()) start();
  else stop();
}

export function initSpotifyConnect(): void {
  if (initialized) return;
  initialized = true;
  radioState.on("power:on", reconcile);
  radioState.on("power:off", reconcile);
  radioState.on("mode:radio", reconcile);
  radioState.on("mode:bluetooth", reconcile);
  radioState.on("band:change", reconcile);
  reconcile();
  console.log("[Spotify] Official Soloist input initialized on logical Band 4");
}

export function restartSpotifyConnect(): void {
  missingKeyReported = false;
  stop();
  if (!stopping && shouldRun()) setTimeout(reconcile, 1000);
}

export function setSpotifyVolume(volume: number): boolean {
  if (!soloistSocket || soloistSocket.readyState !== WebSocket.OPEN) return false;
  const clamped = Math.max(0, Math.min(100, Math.round(volume)));
  soloistSocket.send(JSON.stringify({ type: "command", command: "set_volume", volume: clamped }));
  return true;
}

export function onSpotifyVolumeChanged(listener: (volume: number) => void): () => void {
  volumeListeners.add(listener);
  if (lastSoloistVolume !== null) queueMicrotask(() => listener(lastSoloistVolume!));
  return () => volumeListeners.delete(listener);
}

export async function stopSpotifyConnect(): Promise<void> {
  stopping = true;
  clearRetry();
  stop();
}
