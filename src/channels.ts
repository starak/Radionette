import * as fs from "fs";
import * as path from "path";
import { ChannelInfo } from "./state";

// ── Schema ─────────────────────────────────────────────────────────────
//
// channels.json format:
// {
//   "bands": [
//     { "ordinal": 1, "hardware": 12, "name": "..." },
//     ...
//   ],
//   "channels": [
//     { "id": "nrk-p1", "band": 1, "order": 10, "name": "...", "url": "...", "logo": "..." },
//     ...
//   ]
// }
//
// - `bands.ordinal` is the logical band number used everywhere else in
//   the code (state, tuner, UI).
// - `bands.hardware` is the top-nibble value produced by the physical
//   rotary switch when it selects this band (0..15). Only bands with a
//   hardware nibble in the current rotary's usable positions are
//   reachable via the physical switch; higher bands can still be set
//   via the debug UI virtual dial.
// - `channels.band` references a `bands.ordinal`.
// - `channels.order` is a sparse sort key inside the band (10, 20,
//   30, ...) so inserts don't need renumbering.
// - `channels.id` is the stable identity used in logs, state and event
//   comparisons.

export interface BandInfo {
  ordinal: number;
  hardware: number;
  name: string;
}

interface ChannelEntry {
  id: string;
  band: number;
  order: number;
  name: string;
  url: string;
  logo?: string;
}

interface ChannelsConfig {
  _comment?: string;
  bands: BandInfo[];
  channels: ChannelEntry[];
}

// ── Module state ───────────────────────────────────────────────────────

let bandsByOrdinal: Map<number, BandInfo> = new Map();
let bandsByHardware: Map<number, BandInfo> = new Map();
let channelsById: Map<string, ChannelInfo> = new Map();
let channelsByBand: Map<number, ChannelInfo[]> = new Map();
let allChannelsSorted: ChannelInfo[] = [];

// ── Helpers ────────────────────────────────────────────────────────────

function makeChannelInfo(e: ChannelEntry): ChannelInfo {
  return {
    id: e.id,
    band: e.band,
    order: e.order,
    name: e.name,
    url: e.url,
    logo: e.logo,
  };
}

// ── Public API ─────────────────────────────────────────────────────────

export function loadChannels(configPath?: string): void {
  const filePath =
    configPath || path.resolve(process.cwd(), "channels.json");

  bandsByOrdinal = new Map();
  bandsByHardware = new Map();
  channelsById = new Map();
  channelsByBand = new Map();
  allChannelsSorted = [];

  let config: ChannelsConfig;
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    config = JSON.parse(raw) as ChannelsConfig;
  } catch (err) {
    console.error(`[Channels] Failed to read ${filePath}:`, err);
    return;
  }

  if (!Array.isArray(config.bands) || !Array.isArray(config.channels)) {
    console.error(
      `[Channels] ${filePath}: expected \`bands\` and \`channels\` arrays`
    );
    return;
  }

  // Validate + index bands
  for (const b of config.bands) {
    if (
      typeof b.ordinal !== "number" ||
      typeof b.hardware !== "number" ||
      typeof b.name !== "string"
    ) {
      console.error(`[Channels] Skipping band with bad fields:`, b);
      continue;
    }
    if (b.hardware < 0 || b.hardware > 15) {
      console.error(
        `[Channels] Band ${b.ordinal} has out-of-range hardware nibble ${b.hardware} (must be 0..15)`
      );
      continue;
    }
    if (bandsByOrdinal.has(b.ordinal)) {
      console.error(`[Channels] Duplicate band ordinal ${b.ordinal}`);
      continue;
    }
    if (bandsByHardware.has(b.hardware)) {
      console.error(
        `[Channels] Duplicate band hardware nibble ${b.hardware} (bands ${
          bandsByHardware.get(b.hardware)!.ordinal
        } and ${b.ordinal})`
      );
      continue;
    }
    bandsByOrdinal.set(b.ordinal, b);
    bandsByHardware.set(b.hardware, b);
  }

  // Validate + index channels
  for (const c of config.channels) {
    if (
      typeof c.id !== "string" ||
      typeof c.band !== "number" ||
      typeof c.order !== "number" ||
      typeof c.name !== "string" ||
      typeof c.url !== "string"
    ) {
      console.error(`[Channels] Skipping channel with bad fields:`, c);
      continue;
    }
    if (channelsById.has(c.id)) {
      console.error(`[Channels] Duplicate channel id "${c.id}"`);
      continue;
    }
    if (!bandsByOrdinal.has(c.band)) {
      console.error(
        `[Channels] Channel "${c.id}" references unknown band ${c.band}`
      );
      continue;
    }
    const info = makeChannelInfo(c);
    channelsById.set(c.id, info);
    if (!channelsByBand.has(c.band)) channelsByBand.set(c.band, []);
    channelsByBand.get(c.band)!.push(info);
  }

  // Sort each band's channel list by order
  for (const list of channelsByBand.values()) {
    list.sort((a, b) => a.order - b.order);
  }

  // Master sorted list: by band ordinal, then by order within band
  allChannelsSorted = Array.from(channelsById.values()).sort((a, b) => {
    if (a.band !== b.band) return a.band - b.band;
    return a.order - b.order;
  });

  const bandSummary = Array.from(bandsByOrdinal.values())
    .sort((a, b) => a.ordinal - b.ordinal)
    .map(
      (b) =>
        `${b.ordinal}:${b.name}(hw=${b.hardware},n=${
          channelsByBand.get(b.ordinal)?.length ?? 0
        })`
    )
    .join(" ");
  console.log(
    `[Channels] Loaded ${channelsById.size} channels across ${bandsByOrdinal.size} bands from ${filePath}`
  );
  console.log(`[Channels] Bands: ${bandSummary}`);
}

/**
 * Return the sorted list of channels in the given band ordinal. Empty
 * if the band is unknown or has no channels.
 */
export function channelsForBand(bandOrdinal: number): ChannelInfo[] {
  return channelsByBand.get(bandOrdinal) ?? [];
}

/**
 * Translate a hardware top-nibble reading (0..15) from the physical
 * rotary switch to a band ordinal. Returns null when the nibble
 * doesn't map to any configured band.
 */
export function bandForHardware(nibble: number): number | null {
  const b = bandsByHardware.get(nibble & 0x0f);
  return b ? b.ordinal : null;
}

/**
 * Look up a channel by its stable id. Used by the debug override
 * endpoints.
 */
export function channelById(id: string): ChannelInfo | null {
  return channelsById.get(id) ?? null;
}

/**
 * All bands, sorted by ordinal. Sent to the web UI so it can render
 * band names instead of hardcoding a bank map.
 */
export function getAllBands(): BandInfo[] {
  return Array.from(bandsByOrdinal.values()).sort(
    (a, b) => a.ordinal - b.ordinal
  );
}

/**
 * All channels, sorted by band then order. Sent to the web UI.
 */
export function getAllChannels(): ChannelInfo[] {
  return allChannelsSorted.slice();
}
