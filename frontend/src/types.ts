export interface Channel {
  id: string;
  band: number;
  order: number;
  name: string;
  url: string;
  logo?: string;
}
export interface Band {
  ordinal: number;
  hardware: number;
  name: string;
}
export interface DisplayOption {
  mode: string;
  bits: number;
  label: string;
}
export interface Artwork {
  url: string;
  artist: string;
  title: string;
}
export interface SpotifyQueueItem {
  uid: string;
  uri: string;
  title: string;
  artist: string;
  artworkUrl: string | null;
  source: string;
}
export interface TunerStatus {
  ready: boolean;
  calibration: { minAngle: number; maxAngle: number; invert: boolean };
  latestRaw: number | null;
  fraction: number | null;
  band: number;
  channelsInBand: Array<{ id: string; name: string; order: number }>;
  channelOverride: string | null;
}
export interface RadioStatus {
  type: string;
  power: boolean;
  mode: "off" | "radio" | "bluetooth";
  bluetooth: boolean;
  bluetoothDevice: string | null;
  channel: Channel | null;
  playing: boolean;
  metadata: string | null;
  mono: boolean;
  volume: number;
  volumeSource: "knob" | "spotify" | "software";
  rawGpio: number;
  selectedBand: number;
  tunerFraction: number | null;
  tunerRaw: number | null;
  tunerBand: number;
  nowPlayingArtwork: Artwork | null;
  spotifyQueue: SpotifyQueueItem[];
  displayMode: string;
  displayBits: number;
  displayMapped: boolean;
  bands: Band[];
  channels: Channel[];
  displayTint: { r: number; g: number; b: number };
  displayOptions: DisplayOption[];
  logoOverride: string | null;
  tuner: TunerStatus;
  spotifyBand: number;
}
export interface ChannelsConfig {
  bands: Band[];
  channels: Channel[];
}
export interface DisplayMapping {
  autoArtwork: number;
  autoLogo: number;
  alwaysArtwork: number;
  alwaysLogo: number;
  off: number;
}
export interface SettingsBundle {
  version: number;
  channels: ChannelsConfig;
  bandMapping: Record<string, number>;
  displayMapping: DisplayMapping | null;
  displayPreferences: { tint: { r: number; g: number; b: number } };
  spotify: { configured: boolean; provider: "soloist"; bandOrdinal: number };
  rawGpio: number;
}
export interface WifiStatus {
  connected: boolean;
  ssid: string | null;
  ip: string | null;
  hotspotActive: boolean;
}
export interface WifiNetwork {
  ssid: string;
  signal: number;
  security: string;
  active: boolean;
}
