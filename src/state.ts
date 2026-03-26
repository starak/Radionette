import { EventEmitter } from "events";

export type Mode = "off" | "bluetooth" | "radio";

export interface ChannelInfo {
  number: number;
  name: string;
  url: string;
}

export interface RadioState {
  mode: Mode;
  power: boolean;
  bluetooth: boolean;
  bluetoothDevice: string | null;
  channel: ChannelInfo | null;
  playing: boolean;
  metadata: string | null;
  rawGpio: number;
}

export interface RadioEvents {
  "power:on": [];
  "power:off": [];
  "mode:bluetooth": [];
  "mode:radio": [];
  "channel:change": [channel: ChannelInfo];
  "player:playing": [channel: ChannelInfo];
  "player:stopped": [];
  "player:metadata": [metadata: string];
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
    rawGpio: 0,
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

  setChannel(channel: ChannelInfo | null): void {
    if (this._state.mode !== "radio") return;
    if (
      this._state.channel?.number === channel?.number &&
      this._state.channel?.url === channel?.url
    ) {
      return;
    }
    this._state.channel = channel;
    this._state.metadata = null;
    if (channel) {
      this.emit("channel:change", channel);
    }
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

  setBluetoothDevice(name: string | null): void {
    if (this._state.bluetoothDevice === name) return;
    this._state.bluetoothDevice = name;
    this.emitStateChange();
  }

  private emitStateChange(): void {
    this.emit("state:change", this.state);
  }
}

export const radioState = new RadioStateEmitter();
