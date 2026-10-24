import { EventEmitter } from "events";
import { DisplayMode, DisplaySetting } from "./display-settings";

export type Mode = "off" | "bluetooth" | "radio";
export type VolumeSource = "knob" | "spotify" | "software";

export interface ChannelInfo {
  /** Stable string identifier — key in the channel index. */
  id: string;
  /** Band ordinal (1..N) that this channel belongs to. */
  band: number;
  /** Sort key within the band (sparse: 10, 20, 30, ...). */
  order: number;
  name: string;
  url: string;
  logo?: string;
}

export interface RadioState {
  mode: Mode;
  power: boolean;
  bluetooth: boolean;
  bluetoothDevice: string | null;
  channel: ChannelInfo | null;
  playing: boolean;
  metadata: string | null;
  mono: boolean;
  volume: number;
  volumeSource: VolumeSource;
  rawGpio: number;
  /** Logical band selected by the physical rotary, or 0 when unmapped. */
  selectedBand: number;
  displayMode: DisplayMode;
  displayBits: number;
  displayMapped: boolean;
  // Tuner (AS5600 over I2C). null when the tuner is disabled or hasn't
  // produced its first reading yet.
  tunerFraction: number | null;    // 0..1 across the calibrated sweep
  tunerRaw: number | null;         // most recent 12-bit angle reading
  /** Current band ordinal (1..N), or 0 when the hardware nibble maps to no band. */
  tunerBand: number;
  /**
   * Latest album-art match for the currently-playing song. null when we
   * don't have artwork (no metadata parsed, talk radio, iTunes miss).
   */
  nowPlayingArtwork: NowPlayingArtwork | null;
  spotifyQueue: SpotifyQueueItem[];
}

export interface NowPlayingArtwork {
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

export interface RadioEvents {
  "power:on": [];
  "power:off": [];
  "mode:bluetooth": [];
  "mode:radio": [];
  "channel:change": [channel: ChannelInfo | null];
  "player:playing": [channel: ChannelInfo];
  "player:stopped": [];
  "player:metadata": [metadata: string];
  "mono:on": [];
  "mono:off": [];
  "volume:change": [volume: number];
  "band:change": [band: number];
  "tuner:change": [fraction: number, band: number];
  "artwork:change": [artwork: NowPlayingArtwork | null];
  "display:mode": [setting: DisplaySetting];
  "state:change": [state: RadioState];
}

class RadioStateEmitter extends EventEmitter {
  private _state: RadioState = {
    mode: "off",
    power: false,
    bluetooth: false,
    bluetoothDevice: null,
    channel: null,
    playing: false,
    metadata: null,
    mono: false,
    volume: 100,
    volumeSource: "knob",
    rawGpio: 0,
    selectedBand: 0,
    displayMode: "auto-artwork",
    displayBits: 0,
    displayMapped: false,
    tunerFraction: null,
    tunerRaw: null,
    tunerBand: 0,
    nowPlayingArtwork: null,
    spotifyQueue: [],
  };

  get state(): Readonly<RadioState> {
    return { ...this._state };
  }

  setPower(on: boolean): void {
    if (this._state.power === on) return;
    this._state.power = on;
    if (on) {
      // Reset bluetooth state so setBluetooth() re-evaluates on next poll
      this._state.bluetooth = undefined as any;
      this.emit("power:on");
    } else {
      this._state.mode = "off";
      this._state.bluetooth = false;
      this._state.bluetoothDevice = null;
      this._state.channel = null;
      this._state.playing = false;
      this._state.metadata = null;
      this._state.nowPlayingArtwork = null;
      this.emit("power:off");
    }
    this.emitStateChange();
  }

  setBluetooth(on: boolean): void {
    const changed = this._state.bluetooth !== on;
    this._state.bluetooth = on;

    if (!this._state.power) return;

    // Only act if bluetooth changed or mode hasn't been set yet
    if (!changed && this._state.mode !== "off") return;

    if (on) {
      this._state.mode = "bluetooth";
      this._state.channel = null;
      this._state.playing = false;
      this._state.metadata = null;
      this.emit("mode:bluetooth");
    } else {
      this._state.mode = "radio";
      this._state.bluetoothDevice = null;
      this.emit("mode:radio");
    }
    this.emitStateChange();
  }

  /**
   * Update the currently-tuned channel. Pass null to clear (silence).
   *
   * Emits `channel:change` on every real transition, including the
   * transition to null, so downstream listeners (player, display
   * service) can react.
   */
  setChannel(channel: ChannelInfo | null): void {
    if (this._state.mode !== "radio") return;
    const currentId = this._state.channel?.id ?? null;
    const nextId = channel?.id ?? null;
    if (currentId === nextId) return;
    this._state.channel = channel;
    this._state.metadata = null;
    this._state.nowPlayingArtwork = null;
    this.emit("channel:change", channel);
    this.emitStateChange();
  }

  setPlaying(playing: boolean, channel?: ChannelInfo): void {
    this._state.playing = playing;
    if (playing && channel) {
      this.emit("player:playing", channel);
    } else if (!playing) {
      this._state.metadata = null;
      this.emit("player:stopped");
    }
    this.emitStateChange();
  }

  setMetadata(metadata: string): void {
    if (this._state.metadata === metadata) return;
    this._state.metadata = metadata;
    this.emit("player:metadata", metadata);
    this.emitStateChange();
  }

  setRawGpio(value: number): void {
    this._state.rawGpio = value;
  }

  setSelectedBand(band: number): void {
    const value = band | 0;
    if (this._state.selectedBand === value) return;
    this._state.selectedBand = value;
    this.emit("band:change", value);
    this.emitStateChange();
  }

  setDisplaySetting(setting: DisplaySetting): void {
    const changed =
      this._state.displayMode !== setting.mode ||
      this._state.displayBits !== setting.bits ||
      this._state.displayMapped !== setting.mapped;
    if (!changed) return;
    this._state.displayMode = setting.mode;
    this._state.displayBits = setting.bits;
    this._state.displayMapped = setting.mapped;
    this.emit("display:mode", setting);
    this.emitStateChange();
  }

  setBluetoothDevice(name: string | null): void {
    if (this._state.bluetoothDevice === name) return;
    this._state.bluetoothDevice = name;
    this.emitStateChange();
  }

  setMono(on: boolean): void {
    if (this._state.mono === on) return;
    this._state.mono = on;
    if (on) {
      this.emit("mono:on");
    } else {
      this.emit("mono:off");
    }
    this.emitStateChange();
  }

  setVolume(percent: number, source: VolumeSource = this._state.volumeSource): void {
    const clamped = Math.max(0, Math.min(100, percent));
    if (this._state.volume === clamped && this._state.volumeSource === source) return;
    this._state.volume = clamped;
    this._state.volumeSource = source;
    this.emit("volume:change", clamped);
    this.emitStateChange();
  }

  /**
   * Update the tuner reading. `band` is the current band ordinal
   * (1..N), or 0 when the current hardware nibble maps to no band.
   * Emits `tuner:change` when the fraction is non-null.
   */
  setTuner(fraction: number | null, raw: number | null, band: number): void {
    const changed =
      this._state.tunerFraction !== fraction ||
      this._state.tunerRaw !== raw ||
      this._state.tunerBand !== band;
    this._state.tunerFraction = fraction;
    this._state.tunerRaw = raw;
    this._state.tunerBand = band;
    if (!changed) return;
    if (fraction !== null) {
      this.emit("tuner:change", fraction, band);
    }
    this.emitStateChange();
  }

  /**
   * Record the current now-playing album artwork match. Pass null to
   * clear (e.g. no metadata, iTunes miss, channel changed).
   */
  setArtwork(artwork: NowPlayingArtwork | null): void {
    const current = this._state.nowPlayingArtwork;
    if (current?.url === artwork?.url && current?.artist === artwork?.artist && current?.title === artwork?.title) {
      return;
    }
    this._state.nowPlayingArtwork = artwork;
    this.emit("artwork:change", artwork);
    this.emitStateChange();
  }

  /**
   * Update playback owned by an external player such as Spotify Soloist.
   * Unlike setPlaying/setMetadata this deliberately does not emit the stream
   * player's metadata/stopped events, which would invoke the iTunes artwork
   * lookup and overwrite Soloist's authoritative cover art.
   */
  setExternalPlayback(
    playing: boolean,
    metadata: string | null,
    artwork: NowPlayingArtwork | null,
  ): void {
    const current = this._state.nowPlayingArtwork;
    const changed =
      this._state.playing !== playing ||
      this._state.metadata !== metadata ||
      current?.url !== artwork?.url ||
      current?.artist !== artwork?.artist ||
      current?.title !== artwork?.title;
    if (!changed) return;
    this._state.playing = playing;
    this._state.metadata = metadata;
    this._state.nowPlayingArtwork = artwork;
    this.emitStateChange();
  }

  setSpotifyQueue(queue: SpotifyQueueItem[]): void {
    const unchanged =
      this._state.spotifyQueue.length === queue.length &&
      this._state.spotifyQueue.every((item, index) => {
        const next = queue[index];
        return (
          item.uid === next?.uid &&
          item.title === next?.title &&
          item.artist === next?.artist &&
          item.artworkUrl === next?.artworkUrl &&
          item.source === next?.source
        );
      });
    if (unchanged) return;
    this._state.spotifyQueue = queue;
    this.emitStateChange();
  }

  /**
   * Re-emit channel:change for the current channel if we're in radio mode
   * with a channel selected but not playing. Used to retry playback after
   * network becomes available (e.g. hotspot -> WiFi transition).
   */
  retryPlayback(): void {
    if (this._state.mode === "radio" && this._state.channel && !this._state.playing) {
      console.log(`[State] Retrying playback: ${this._state.channel.name}`);
      this.emit("channel:change", this._state.channel);
    }
  }

  private emitStateChange(): void {
    this.emit("state:change", this.state);
  }
}

export const radioState = new RadioStateEmitter();
