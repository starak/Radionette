import * as fs from "fs";
import * as path from "path";
import { ChannelInfo } from "./state";

interface ChannelEntry {
  name: string;
  url: string;
  logo?: string;
}

interface ChannelsConfig {
  _comment?: string;
  channels: Record<string, ChannelEntry>;
}

let channelMap: Map<number, ChannelEntry> = new Map();

export function loadChannels(
  configPath?: string
): Map<number, ChannelEntry> {
  const filePath =
    configPath || path.resolve(process.cwd(), "channels.json");

  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const config: ChannelsConfig = JSON.parse(raw);

    channelMap = new Map();
    for (const [key, entry] of Object.entries(config.channels)) {
      const num = parseInt(key, 10);
      if (!isNaN(num) && entry.name && entry.url) {
        channelMap.set(num, entry);
      }
    }

    console.log(
      `[Channels] Loaded ${channelMap.size} channels from ${filePath}`
    );
    return channelMap;
  } catch (err) {
    console.error(`[Channels] Failed to load ${filePath}:`, err);
    return channelMap;
  }
}

export function lookupChannel(channelBits: number): ChannelInfo | null {
  const entry = channelMap.get(channelBits);
  if (!entry) return null;
  return {
    number: channelBits,
    name: entry.name,
    url: entry.url,
    logo: entry.logo,
  };
}

export function getAllChannels(): Array<{ number: number } & ChannelEntry> {
  return Array.from(channelMap.entries())
    .map(([num, entry]) => ({ number: num, ...entry }))
    .sort((a, b) => a.number - b.number);
}
