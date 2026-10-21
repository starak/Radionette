import { writable } from "svelte/store";
import type { RadioStatus } from "../types";

export const radio = writable<RadioStatus|null>(null);
export const connected = writable(false);
let socket:WebSocket|null = null;
let reconnect:number|undefined;

export function startRadioSocket():() => void {
  let stopped = false;
  const connect = () => {
    if (stopped) return;
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    socket = new WebSocket(`${protocol}//${location.host}/socket`);
    socket.onopen = () => connected.set(true);
    socket.onmessage = event => {
      try { const value = JSON.parse(event.data); if (value.type === "state") radio.set(value); }
      catch (err) { console.error("WebSocket data", err); }
    };
    socket.onclose = () => { connected.set(false); if (!stopped) reconnect = window.setTimeout(connect, 2000); };
    socket.onerror = () => socket?.close();
  };
  connect();
  return () => { stopped = true; clearTimeout(reconnect); socket?.close(); };
}
