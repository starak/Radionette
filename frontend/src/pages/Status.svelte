<script lang="ts">
  import AppShell from "../components/AppShell.svelte";
  import { connected, radio } from "../lib/radio";
  import type { RadioStatus } from "../types";
  let failed = false;
  let lastSource = "";

  $: s = $radio;
  $: station = getStation(s);
  $: source = getArtwork(s);
  $: if (source !== lastSource) {
    lastSource = source || "";
    failed = false;
  }
  function getStation(v: RadioStatus | null) {
    if (!v?.power) return "Radionette";
    if (v.mode === "bluetooth") return v.bluetoothDevice || "Bluetooth";
    return v.channel?.name || "Radionette";
  }

  function getArtwork(v: RadioStatus | null): string | null {
    if (!v) return null;
    if (v.nowPlayingArtwork?.url && ["auto-artwork", "always-artwork"].includes(v.displayMode)) {
      return v.nowPlayingArtwork.url;
    }
    if (v.mode === "bluetooth") {
      return v.bluetoothDevice ? "/logos/bluetooth-connected.png" : "/logos/bluetooth.png";
    }
    if (v.channel) return v.channel.logo ? `/logos/${encodeURIComponent(v.channel.logo)}` : null;
    return "/logos/default.png";
  }

  function track(v: RadioStatus | null) {
    if (!v?.power) return "Power is off";
    if (v.mode === "bluetooth") {
      return v.bluetoothDevice ? "Connected and ready" : "Waiting for a device…";
    }
    if (v.channel) return v.metadata || "Waiting for now-playing information…";
    return "No station selected";
  }
  function eyebrow(v: RadioStatus | null) {
    if (!v?.power) return "Radio offline";
    if (v.mode === "bluetooth") return "Bluetooth";
    return v.playing ? "Now playing" : "Tuned";
  }
</script>

<AppShell>
  <main class="page">
    <section class="hero card">
      {#if source && !failed}
        <img class="ambient" src={source} alt="" />
      {/if}
      <div class="art-wrap">
        <div class="fallback">{station}</div>
        {#if source && !failed}
          <img class="art" src={source} alt="" on:error={() => (failed = true)} />
        {/if}
      </div>
      <div class="info">
        <div class="eyebrow">{eyebrow(s)}</div>
        <h1>{station}</h1>
        <div class="track">{track(s)}</div>
        <div class="sub">
          {s?.nowPlayingArtwork
            ? `${s.nowPlayingArtwork.artist} · ${s.nowPlayingArtwork.title}`
            : "Internet radio"}
        </div>
        <div class="chips">
          <span class:live={s?.playing} class="pill">
            {s?.playing ? "● Playing" : "Stopped"}
          </span>
          <span class="pill">{s?.mode || "off"}</span>
          <span class="pill">{s?.mono ? "Mono" : "Stereo"}</span>
          <span class="pill">{s?.displayMode?.replaceAll("-", " ") || "display"}</span>
        </div>
        <div class="volume">
          <span>Volume</span>
          <div><i style={`width:${s?.volume || 0}%`}></i></div>
          <b>{s?.volume || 0}%</b>
        </div>
      </div>
    </section>
    <div class="section-title">Stations</div>
    <section class="bands">
      {#each s?.bands || [] as band}
        {@const channels = (s?.channels || [])
          .filter((c) => c.band === band.ordinal)
          .sort((a, b) => a.order - b.order)}
        {#if channels.length}
          <div class="card band">
            <h2>{band.name}</h2>
            {#each channels as channel}
              <div class:active={s?.channel?.id === channel.id} class="row">
                <span>{channel.order}</span>{channel.name}
              </div>
            {/each}
          </div>
        {/if}
      {/each}
    </section>
  </main>
  <div class:live={$connected} class="connection">{$connected ? "Live" : "Reconnecting"}</div>
</AppShell>

<style>
  .hero {
    position: relative;
    overflow: hidden;
    display: grid;
    grid-template-columns: 240px 1fr;
    gap: clamp(1.2rem, 5vw, 3rem);
    align-items: center;
    min-height: 360px;
    padding: clamp(1rem, 4vw, 2rem);
  }
  .ambient {
    position: absolute;
    inset: -15%;
    width: 130%;
    height: 130%;
    object-fit: cover;
    filter: blur(65px) saturate(1.2);
    opacity: 0.16;
  }
  .hero > *:not(.ambient) {
    position: relative;
  }
  .art-wrap {
    position: relative;
    width: 240px;
    max-width: 100%;
    aspect-ratio: 1;
  }
  .art,
  .fallback {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    border-radius: 50%;
  }
  .art {
    object-fit: cover;
    box-shadow:
      0 22px 70px #0009,
      0 0 0 10px #ffffff06;
  }
  .fallback {
    display: grid;
    place-items: center;
    background: #000;
    padding: 2rem;
    text-align: center;
    font-size: 1.5rem;
    font-weight: 800;
  }
  .eyebrow {
    color: var(--accent);
    text-transform: uppercase;
    letter-spacing: 0.16em;
    font-size: 0.72rem;
    font-weight: 750;
  }
  h1 {
    font-size: clamp(2rem, 6vw, 4.4rem);
    line-height: 0.98;
    margin: 0.45rem 0 0.8rem;
    letter-spacing: -0.045em;
  }
  .track {
    font-size: clamp(1rem, 2.4vw, 1.45rem);
    color: #d7dde6;
  }
  .sub {
    color: var(--muted);
    margin-top: 0.45rem;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.45rem;
    margin-top: 1.3rem;
  }
  .volume {
    margin-top: 1.25rem;
    display: grid;
    grid-template-columns: auto 1fr auto;
    gap: 0.7rem;
    align-items: center;
    color: var(--muted);
    font-size: 0.78rem;
  }
  .volume > div {
    height: 6px;
    background: #ffffff12;
    border-radius: 99px;
    overflow: hidden;
  }
  .volume i {
    display: block;
    height: 100%;
    background: linear-gradient(90deg, var(--accent), #ffd49e);
  }
  .section-title {
    margin: 1.6rem 0.25rem 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.18em;
    color: var(--muted);
    font-size: 0.75rem;
  }
  .bands {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    gap: 0.8rem;
  }
  .band {
    margin: 0;
  }
  .row {
    padding: 0.5rem;
    border-radius: 8px;
    color: var(--muted);
  }
  .row span {
    display: inline-block;
    width: 36px;
    font: 11px monospace;
    color: #657080;
  }
  .row.active {
    background: #f09a5415;
    color: #fff;
  }
  .connection {
    position: fixed;
    right: 0.75rem;
    bottom: max(0.75rem, env(safe-area-inset-bottom));
    padding: 0.38rem 0.65rem;
    border: 1px solid var(--line);
    background: #0b0e13dd;
    border-radius: 999px;
    color: var(--red);
    font-size: 0.72rem;
  }
  .connection.live {
    color: var(--green);
  }
  @media (max-width: 720px) {
    .hero {
      grid-template-columns: 1fr;
      text-align: center;
      min-height: 0;
    }
    .art-wrap {
      width: min(70vw, 240px);
      margin: auto;
    }
    .chips {
      justify-content: center;
    }
    .volume {
      text-align: left;
    }
  }
</style>
