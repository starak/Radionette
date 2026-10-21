import * as fs from "fs";
import * as path from "path";
import { ChannelInfo } from "./state";
import { radionetteConfigPath, writeJsonAtomic } from "./config-storage";

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

export interface ChannelEntry {
  id: string;
  band: number;
  order: number;
  name: string;
  url: string;
  logo?: string;
}

export interface ChannelsConfig {
  _comment?: string;
  bands: BandInfo[];
  channels: ChannelEntry[];
}

export type BandHardwareOverride = Record<string, number>;

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
  const localPath = process.env.RADIONETTE_CHANNELS || radionetteConfigPath("channels.json");
  const filePath = configPath || (fs.existsSync(localPath) ? localPath : path.resolve(process.cwd(), "channels.json"));

  bandsByOrdinal = new Map();
  bandsByHardware = new Map();
  channelsById = new Map();
  channelsByBand = new Map();
  allChannelsSorted = [];

  let config: ChannelsConfig;
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    config = validateChannelsConfig(JSON.parse(raw));
  } catch (err) {
    console.error(`[Channels] Failed to read ${filePath}:`, err);
    return;
  }

  // A radio's physical selector may produce different nibble values from
  // another radio even though both use the same stations and logical bands.
  // Keep that machine-specific wiring outside channels.json so normal deploys
  // don't overwrite it and one checkout can serve multiple radios.
  const overridePath =
    process.env.RADIONETTE_BAND_MAPPING ||
    radionetteConfigPath("band-mapping.json");
  if (fs.existsSync(overridePath)) {
    try {
      const override = JSON.parse(
        fs.readFileSync(overridePath, "utf-8"),
      ) as BandHardwareOverride;
      config.bands = config.bands.map((band) => {
        const hardware = override[String(band.ordinal)];
        return Number.isInteger(hardware) && hardware >= 0 && hardware <= 15
          ? { ...band, hardware }
          : band;
      });
      console.log(`[Channels] Applied band mapping override from ${overridePath}`);
    } catch (err) {
      console.error(`[Channels] Failed to read band mapping override ${overridePath}:`, err);
    }
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

export function validateChannelsConfig(value: any): ChannelsConfig {
  if (!value || !Array.isArray(value.bands) || !Array.isArray(value.channels)) {
    throw new Error("expected bands and channels arrays");
  }
  const ordinals = new Set<number>();
  const hardwareValues = new Set<number>();
  const bands: BandInfo[] = value.bands.map((band: any, index: number) => {
    if (!Number.isInteger(band?.ordinal) || band.ordinal < 1) throw new Error(`band ${index + 1}: ordinal must be a positive integer`);
    if (ordinals.has(band.ordinal)) throw new Error(`duplicate band ordinal ${band.ordinal}`);
    if (!Number.isInteger(band.hardware) || band.hardware < 0 || band.hardware > 15) throw new Error(`band ${band.ordinal}: hardware must be 0..15`);
    if (hardwareValues.has(band.hardware)) throw new Error(`duplicate band hardware value ${band.hardware}`);
    if (typeof band.name !== "string" || !band.name.trim()) throw new Error(`band ${band.ordinal}: name is required`);
    ordinals.add(band.ordinal);
    hardwareValues.add(band.hardware);
    return { ordinal: band.ordinal, hardware: band.hardware, name: band.name.trim() };
  });
  const ids = new Set<string>();
  const channels: ChannelEntry[] = value.channels.map((channel: any, index: number) => {
    if (typeof channel?.id !== "string" || !channel.id.trim()) throw new Error(`channel ${index + 1}: id is required`);
    const id = channel.id.trim();
    if (ids.has(id)) throw new Error(`duplicate channel id ${id}`);
    if (!Number.isInteger(channel.band) || !ordinals.has(channel.band)) throw new Error(`channel ${id}: unknown band ${channel.band}`);
    if (typeof channel.order !== "number" || !Number.isFinite(channel.order)) throw new Error(`channel ${id}: order must be a number`);
    if (typeof channel.name !== "string" || !channel.name.trim()) throw new Error(`channel ${id}: name is required`);
    if (typeof channel.url !== "string") throw new Error(`channel ${id}: URL is required`);
    try {
      const parsedUrl = new URL(channel.url.trim());
      if (!/^https?:$/.test(parsedUrl.protocol) || !parsedUrl.hostname) throw new Error();
    } catch {
      throw new Error(`channel ${id}: enter a valid http:// or https:// URL`);
    }
    if (channel.logo !== undefined && typeof channel.logo !== "string") throw new Error(`channel ${id}: logo must be text`);
    ids.add(id);
    return {
      id,
      band: channel.band,
      order: channel.order,
      name: channel.name.trim(),
      url: channel.url.trim(),
      ...(channel.logo?.trim() ? { logo: channel.logo.trim() } : {}),
    };
  });
  return { bands, channels };
}

export function saveChannelsConfig(value: unknown): ChannelsConfig {
  const validated = validateChannelsConfig(value);
  const filePath = process.env.RADIONETTE_CHANNELS || radionetteConfigPath("channels.json");
  writeJsonAtomic(filePath, validated);
  loadChannels(filePath);
  return getChannelsConfig();
}

export function getChannelsConfig(): ChannelsConfig {
  return {
    bands: getAllBands().map((band) => ({ ...band })),
    channels: getAllChannels().map((channel) => ({ ...channel })),
  };
}

export function validateBandMapping(value: any, bands: BandInfo[] = getAllBands()): BandHardwareOverride {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("band mapping must be an object");
  const result: BandHardwareOverride = {};
  const seen = new Set<number>();
  for (const band of bands) {
    const hardware = value[String(band.ordinal)];
    if (!Number.isInteger(hardware) || hardware < 0 || hardware > 15) throw new Error(`band ${band.ordinal}: hardware must be 0..15`);
    if (seen.has(hardware)) throw new Error(`duplicate band hardware value ${hardware}`);
    result[String(band.ordinal)] = hardware;
    seen.add(hardware);
  }
  return result;
}

export function saveBandMapping(value: unknown): BandHardwareOverride {
  const validated = validateBandMapping(value);
  const filePath = process.env.RADIONETTE_BAND_MAPPING || radionetteConfigPath("band-mapping.json");
  writeJsonAtomic(filePath, validated);
  loadChannels();
  return validated;
}

export function getBandMapping(): BandHardwareOverride {
  return Object.fromEntries(getAllBands().map((band) => [String(band.ordinal), band.hardware]));
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
