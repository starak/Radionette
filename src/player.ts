import { ChildProcess, spawn } from "child_process";
import { radioState, ChannelInfo } from "./state";

const PLAYER_CMD = "/usr/bin/mpg123";
const PLAYER_ARGS = ["--long-tag", "-v"];

let playerProcess: ChildProcess | null = null;
let currentUrl: string | null = null;

// Serialize all player operations to prevent overlapping spawns
let pendingOperation: Promise<void> = Promise.resolve();
let desiredChannel: ChannelInfo | null = null;
let lastMetadata: string | null = null;

function killPlayer(): void {
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
  console.log(`[Player] Playing: ${channel.name} (${channel.url})`);
  currentUrl = channel.url;

  const proc = spawn(PLAYER_CMD, [...PLAYER_ARGS, channel.url], {
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
    }
  });

  radioState.setPlaying(true, channel);
}

function schedulePlay(channel: ChannelInfo): void {
  desiredChannel = channel;

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

  radioState.on("channel:change", (channel: ChannelInfo) => {
    schedulePlay(channel);
  });

  radioState.on("mode:radio", () => {
    const state = radioState.state;
    if (state.channel) {
      schedulePlay(state.channel);
    }
  });

  console.log("[Player] Initialized, listening for state changes.");
}
