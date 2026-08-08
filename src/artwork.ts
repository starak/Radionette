/**
 * Now-playing artwork lookup via iTunes Search API.
 *
 * Radio streams don't carry image URLs in their metadata — ICY tags are
 * text-only, HLS manifests contain no artwork either. What they DO carry
 * is a "now playing" string that usually formats as "Artist - Song".
 *
 * We parse that string, query iTunes Search, and expose the resulting
 * album-art URL via radioState. The display service then prefers the
 * artwork over the channel's static logo whenever it's fresh.
 *
 * Cache is in-memory only; artwork evictions happen implicitly by
 * capping the map size. iTunes Search has generous unauthenticated
 * limits (roughly 20 req/min) so we don't need aggressive throttling,
 * just a per-song debounce so we don't fire on a burst of duplicate
 * "Now playing:" lines from mpg123/ffmpeg.
 */

import { radioState } from "./state";

const ITUNES_ENDPOINT = "https://itunes.apple.com/search";
const REQUEST_TIMEOUT_MS = 5000;

// Wait this long after a metadata change before firing the lookup, so a
// storm of duplicate ICY frames doesn't hit the API multiple times.
const LOOKUP_DEBOUNCE_MS = 400;

// Cap the memory cache so a long-running radio session doesn't leak.
const CACHE_MAX = 200;

interface ArtworkHit {
  url: string;
  artist: string;
  title: string;
}

// Cache keyed by a normalised query string. Missing lookups get stored
// as `null` so we don't retry a hopeless "Nyhetene med Ida Gjellerud"
// on every metadata refresh.
const cache = new Map<string, ArtworkHit | null>();

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let inflightKey: string | null = null;
let lastMetadata: string | null = null;

/**
 * Parse a "now playing" string into { artist, title } if possible.
 *
 * Supported formats:
 *   "Artist - Title"
 *   "Artist – Title"          (en-dash)
 *   "Programme: Title, Artist" (NRK-style — take the tail before the
 *                              programme colon and try to swap)
 *
 * Returns null if the string is a bare programme name (no artist/song
 * separator we can identify) — those get skipped so we keep the
 * channel logo instead of guessing.
 */
export function parseNowPlaying(
  raw: string,
): { artist: string; title: string } | null {
  const s = raw.trim();
  if (!s) return null;

  // NRK-style: "Programme name: Title, Artist"
  // Strip the "Programme name:" prefix if present, then treat as "Title, Artist"
  const colonIdx = s.indexOf(": ");
  let body = colonIdx > 0 ? s.slice(colonIdx + 2).trim() : s;

  // Split on the first " - " or " – " (en-dash) or " — " (em-dash)
  const dashMatch = body.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (dashMatch) {
    const left = dashMatch[1].trim();
    const right = dashMatch[2].trim();
    if (left && right) return { artist: left, title: right };
  }

  // No dash: try "Title, Artist" (NRK format after the colon strip)
  if (colonIdx > 0) {
    const commaMatch = body.match(/^(.+),\s+([^,]+)$/);
    if (commaMatch) {
      const title = commaMatch[1].trim();
      const artist = commaMatch[2].trim();
      if (title && artist) return { artist, title };
    }
  }

  return null;
}

/**
 * Query iTunes Search for an artist + title. Returns the highest-
 * resolution artwork URL available (upgraded from the API's default
 * 100x100 thumbnail to 600x600).
 */
async function queryItunes(
  artist: string,
  title: string,
): Promise<ArtworkHit | null> {
  const term = `${artist} ${title}`.replace(/\s+/g, " ").trim();
  const url =
    `${ITUNES_ENDPOINT}?term=${encodeURIComponent(term)}` +
    `&entity=song&limit=1`;

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, { signal: ac.signal });
  } catch (err: any) {
    if (err?.name === "AbortError") {
      console.warn(`[Artwork] iTunes timeout for "${term}"`);
    } else {
      console.warn(`[Artwork] iTunes fetch failed for "${term}": ${err?.message ?? err}`);
    }
    return null;
  } finally {
    clearTimeout(t);
  }
  if (!res.ok) {
    console.warn(`[Artwork] iTunes returned ${res.status} for "${term}"`);
    return null;
  }
  let json: any;
  try {
    json = await res.json();
  } catch (err: any) {
    console.warn(`[Artwork] iTunes JSON parse failed: ${err?.message ?? err}`);
    return null;
  }
  const first = json?.results?.[0];
  if (!first?.artworkUrl100) return null;
  // Upgrade to a higher-resolution image. iTunes serves size in the URL
  // path: bumping 100x100 -> 600x600 works for essentially every entry.
  const hires = String(first.artworkUrl100).replace(
    /\/\d+x\d+bb\.(jpg|png)$/i,
    "/600x600bb.$1",
  );
  return {
    url: hires,
    artist: String(first.artistName ?? artist),
    title: String(first.trackName ?? title),
  };
}

function cacheSet(key: string, value: ArtworkHit | null): void {
  if (cache.size >= CACHE_MAX) {
    // Drop the oldest entry (Map preserves insertion order).
    const first = cache.keys().next();
    if (!first.done) cache.delete(first.value);
  }
  cache.set(key, value);
}

async function runLookup(metadata: string): Promise<void> {
  const parsed = parseNowPlaying(metadata);
  if (!parsed) {
    radioState.setArtwork(null);
    return;
  }
  const key = `${parsed.artist.toLowerCase()}\u0000${parsed.title.toLowerCase()}`;
  if (cache.has(key)) {
    const cached = cache.get(key) ?? null;
    radioState.setArtwork(cached);
    return;
  }
  if (inflightKey === key) return;
  inflightKey = key;
  try {
    const hit = await queryItunes(parsed.artist, parsed.title);
    cacheSet(key, hit);
    if (hit) {
      console.log(
        `[Artwork] iTunes match: "${parsed.artist} - ${parsed.title}" → ${hit.url}`,
      );
    }
    radioState.setArtwork(hit);
  } finally {
    if (inflightKey === key) inflightKey = null;
  }
}

function onMetadata(metadata: string): void {
  if (metadata === lastMetadata) return;
  lastMetadata = metadata;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void runLookup(metadata);
  }, LOOKUP_DEBOUNCE_MS);
}

function onChannelChange(): void {
  // Any channel change (including null) clears artwork so we don't briefly
  // show the previous song's album art on the new station.
  lastMetadata = null;
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  inflightKey = null;
  radioState.setArtwork(null);
}

function onPlayerStopped(): void {
  lastMetadata = null;
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  inflightKey = null;
  radioState.setArtwork(null);
}

export function initArtwork(): void {
  radioState.on("player:metadata", onMetadata);
  radioState.on("channel:change", onChannelChange);
  radioState.on("player:stopped", onPlayerStopped);
  console.log("[Artwork] Listening for now-playing metadata (iTunes Search)");
}

export function stopArtwork(): void {
  radioState.off("player:metadata", onMetadata);
  radioState.off("channel:change", onChannelChange);
  radioState.off("player:stopped", onPlayerStopped);
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  cache.clear();
  lastMetadata = null;
  inflightKey = null;
}
