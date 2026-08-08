import { ChildProcess, spawn } from "child_process";
import { radioState, ChannelInfo } from "./state";

// ── Player selection ───────────────────────────────────────────────────
//
// mpg123 is used for direct icecast MP3 streams (light, native ICY
// metadata parsing). ffmpeg is used for HLS (.m3u8) — mpg123 cannot parse
// the manifest or the AAC-in-MPEG-TS segments most HLS streams ship.
// The two spawn signatures are different so we route on URL.

const MPG123_CMD = "/usr/bin/mpg123";
const MPG123_ARGS = ["--long-tag", "-v"];

const FFMPEG_CMD = "/usr/bin/ffmpeg";
// ffmpeg → PulseAudio directly. -nostdin so it doesn't compete for our
// stdin. -loglevel info surfaces stream metadata; -hide_banner cuts the
// startup noise. -reconnect_streamed 1 asks ffmpeg to recover from
// transient CDN failures without dying.
const FFMPEG_BASE_ARGS = [
  "-nostdin",
  "-hide_banner",
  "-loglevel", "info",
  "-reconnect", "1",
  "-reconnect_streamed", "1",
  "-reconnect_delay_max", "5",
];
const FFMPEG_OUT_ARGS = ["-f", "pulse", "radionette"];

function isHlsUrl(url: string): boolean {
  // Strip any query string before checking the extension. HLS manifests
  // are almost always served as .m3u8 (and never as raw MP3).
  const bare = url.split("?")[0].toLowerCase();
  return bare.endsWith(".m3u8") || bare.includes(".m3u8/");
}

let playerProcess: ChildProcess | null = null;
let currentUrl: string | null = null;

// Serialize all player operations to prevent overlapping spawns
let pendingOperation: Promise<void> = Promise.resolve();
let desiredChannel: ChannelInfo | null = null;
let lastMetadata: string | null = null;

// Retry state for failed stream connections
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryCount = 0;
const RETRY_DELAYS = [5000, 10000, 30000]; // escalating backoff, caps at 30s

function cancelRetry(): void {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
}

function scheduleRetry(): void {
  // Only retry if we still have a desired channel and no player is running
  if (!desiredChannel || playerProcess) return;

  const delay = RETRY_DELAYS[Math.min(retryCount, RETRY_DELAYS.length - 1)];
  retryCount++;
  console.log(
    `[Player] Scheduling retry #${retryCount} in ${delay / 1000}s for: ${desiredChannel.name}`
  );

  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (desiredChannel && !playerProcess) {
      console.log(`[Player] Retrying playback: ${desiredChannel.name}`);
      spawnPlayer(desiredChannel);
    }
  }, delay);
}

function killPlayer(): void {
  cancelRetry();
  if (!playerProcess) return;

  const proc = playerProcess;
  playerProcess = null;
  currentUrl = null;
  lastMetadata = null;

  try {
    // SIGKILL — no need for graceful shutdown on a stream player
    proc.kill("SIGKILL");
  } catch {
    // already dead
  }
}

function spawnPlayer(channel: ChannelInfo): void {
  const hls = isHlsUrl(channel.url);
  const kind = hls ? "ffmpeg (HLS)" : "mpg123";
  console.log(`[Player] Playing: ${channel.name} via ${kind} (${channel.url})`);
  currentUrl = channel.url;

  const cmd = hls ? FFMPEG_CMD : MPG123_CMD;
  const args = hls
    ? [...FFMPEG_BASE_ARGS, "-i", channel.url, ...FFMPEG_OUT_ARGS]
    : [...MPG123_ARGS, channel.url];

  const proc = spawn(cmd, args, {
    stdio: ["pipe", "pipe", "pipe"],
  });

  playerProcess = proc;

  proc.stdout?.on("data", (data: Buffer) => {
    // Only parse if this is still the active process
    if (proc === playerProcess) {
      parseOutput(data.toString());
    }
  });

  proc.stderr?.on("data", (data: Buffer) => {
    if (proc === playerProcess) {
      parseOutput(data.toString());
    }
  });

  proc.on("error", (err) => {
    if (proc === playerProcess) {
      console.error(`[Player] Process error:`, err.message);
      playerProcess = null;
      currentUrl = null;
      radioState.setPlaying(false);
      // Retry if we still want this channel
      if (desiredChannel) {
        scheduleRetry();
      }
    }
  });

  proc.on("exit", (code, signal) => {
    if (proc === playerProcess) {
      console.log(
        `[Player] Process exited (code: ${code}, signal: ${signal})`
      );
      playerProcess = null;
      currentUrl = null;
      radioState.setPlaying(false);
      // Retry if we still want this channel (unexpected exit, not user-initiated stop)
      if (desiredChannel) {
        scheduleRetry();
      }
    }
  });

  radioState.setPlaying(true, channel);
}

function schedulePlay(channel: ChannelInfo): void {
  desiredChannel = channel;
  retryCount = 0;
  cancelRetry();

  pendingOperation = pendingOperation.then(() => {
    // Only play if this is still the desired channel
    // (user may have flipped past this one already)
    if (desiredChannel !== channel) return;

    // If already playing this URL, skip
    if (currentUrl === channel.url && playerProcess) return;

    killPlayer();
    spawnPlayer(channel);
  });
}

function scheduleStop(): void {
  desiredChannel = null;
  cancelRetry();

  pendingOperation = pendingOperation.then(() => {
    killPlayer();
    radioState.setPlaying(false);
  });
}

function parseOutput(text: string): void {
  // mpg123 outputs ICY stream info like:
  // ICY-META:  StreamTitle='Artist - Song';
  const icyMatch = text.match(
    /ICY-META:\s*StreamTitle='([^']*)'/i
  );
  if (icyMatch && icyMatch[1]) {
    const metadata = icyMatch[1].trim();
    if (metadata) {
      if (metadata !== lastMetadata) {
        console.log(`[Player] Now playing: ${metadata}`);
        lastMetadata = metadata;
      }
      radioState.setMetadata(metadata);
    }
    return;
  }

  // Also catch the simpler ICY Info format
  const icyInfo = text.match(
    /ICY Info:\s*StreamTitle=([^;]*)/i
  );
  if (icyInfo && icyInfo[1]) {
    const metadata = icyInfo[1].replace(/^'|'$/g, "").trim();
    if (metadata) {
      if (metadata !== lastMetadata) {
        console.log(`[Player] Now playing: ${metadata}`);
        lastMetadata = metadata;
      }
      radioState.setMetadata(metadata);
    }
    return;
  }

  // ffmpeg (HLS) — timed ID3 metadata surfaces as lines like:
  //   [Parsed_showinfo] ... title: Artist - Song
  //   Metadata update for StreamTitle: Artist - Song
  //     title           : Artist - Song
  // Match either the "StreamTitle:" form (from ffmpeg's -metadata_header)
  // or an isolated "title           : <text>" line from stream metadata.
  const ffTitle = text.match(
    /StreamTitle\s*:\s*([^\r\n]+)|(?:^|\n)\s*title\s*:\s*([^\r\n]+)/i
  );
  if (ffTitle) {
    const metadata = (ffTitle[1] || ffTitle[2] || "").trim();
    if (metadata && metadata !== "N/A") {
      if (metadata !== lastMetadata) {
        console.log(`[Player] Now playing: ${metadata}`);
        lastMetadata = metadata;
      }
      radioState.setMetadata(metadata);
    }
  }
}

export async function stopPlayer(): Promise<void> {
  scheduleStop();
  await pendingOperation;
  console.log("[Player] Stopped.");
}

export function initPlayer(): void {
  radioState.on("power:off", () => {
    console.log("[Player] Power off — stopping playback.");
    scheduleStop();
  });

  radioState.on("mode:bluetooth", () => {
    console.log("[Player] Bluetooth mode — stopping radio playback.");
    scheduleStop();
  });

  radioState.on("channel:change", (channel: ChannelInfo | null) => {
    if (channel) {
      schedulePlay(channel);
    } else {
      // Silence — happens when the tuner is on a band with no channels,
      // or when the physical rotary lands on an unmapped nibble.
      console.log("[Player] Channel cleared — stopping playback.");
      scheduleStop();
    }
  });

  radioState.on("mode:radio", () => {
    const state = radioState.state;
    if (state.channel) {
      schedulePlay(state.channel);
    }
  });

  console.log("[Player] Initialized, listening for state changes.");
}
