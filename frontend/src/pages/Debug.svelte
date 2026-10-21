<script lang="ts">
  import AppShell from "../components/AppShell.svelte";
  import ControlButton from "../components/ControlButton.svelte";
  import Toast from "../components/Toast.svelte";
  import { api } from "../lib/api";
  import { radio } from "../lib/radio";

  let message = "";
  let good = true;
  let volume = 0;
  let lastVolume = -1;
  let tintR = 1;
  let tintG = 1;
  let tintB = 1;
  let lastTint = "";

  $: state = $radio;
  $: raw = state?.rawGpio || 0;
  $: bits = raw.toString(2).padStart(11, "0");

  $: if (state) {
    if (state.volume !== lastVolume) {
      lastVolume = state.volume;
      volume = state.volume;
    }

    const tintKey = JSON.stringify(state.displayTint);
    if (tintKey !== lastTint) {
      lastTint = tintKey;
      tintR = state.displayTint.r;
      tintG = state.displayTint.g;
      tintB = state.displayTint.b;
    }
  }

  const displayLabels: Record<string, string> = {
    "auto-artwork": "Auto + artwork",
    "auto-logo": "Auto logo",
    "always-artwork": "Always + artwork",
    "always-logo": "Always logo",
    off: "Off",
  };

  function notify(text: string, ok = true) {
    message = text;
    good = ok;
    setTimeout(() => (message = ""), 4000);
  }

  async function post(url: string, body?: unknown) {
    try {
      await api(url, {
        method: "POST",
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return true;
    } catch (error) {
      notify((error as Error).message, false);
      return false;
    }
  }

  function setVirtualControl(
    field: "mono" | "power" | "bluetooth" | "band" | "display",
    value: number,
  ) {
    if (!state) return;

    let mono = (raw >> 10) & 1;
    let power = (raw >> 9) & 1;
    let bluetooth = (raw >> 8) & 1;
    let band = (raw >> 4) & 15;
    let display = raw & 15;

    if (field === "mono") mono = value;
    if (field === "power") power = value;
    if (field === "bluetooth") bluetooth = value;
    if (field === "band") band = value;
    if (field === "display") display = value;

    const nextRaw = (mono << 10) | (power << 9) | (bluetooth << 8) | (band << 4) | display;
    post("/api/debug/gpio", { value: nextRaw });
  }

  async function resetOverrides() {
    if (await post("/api/debug/reset")) notify("Temporary overrides cleared");
  }

  function setChannel(id: string | null) {
    post("/api/debug/channel", { id });
  }

  function setVolume() {
    post("/api/debug/volume", { volume });
  }

  function applyTint() {
    post("/api/debug/tint", { r: tintR, g: tintG, b: tintB });
  }

  function applyTintPreset(r: number, g: number, b: number) {
    tintR = r;
    tintG = g;
    tintB = b;
    applyTint();
  }

  function calibrate(kind: "min" | "max") {
    post("/api/tuner/calibrate", { kind });
  }

  function invertTuner() {
    if (state) post("/api/tuner/invert", { invert: !state.tuner.calibration.invert });
  }

  function systemAction(url: string, confirmation: string) {
    if (confirm(confirmation)) post(url);
  }
</script>

<AppShell subtitle="Diagnostics">
  <main class="page">
    <section class="card">
      <h2>GPIO</h2>
      <div class="bitline">
        {#each bits as bit, index}
          <span class:on={bit === "1"} class:control={index < 3}>{bit}</span>
        {/each}
      </div>

      <div class="decoded">
        <div><small>Power</small><b>{state?.power ? "ON" : "OFF"}</b></div>
        <div><small>Mode</small><b>{state?.mode || "—"}</b></div>
        <div><small>Band</small><b>{state?.tunerBand || 0}</b></div>
        <div>
          <small>Display</small>
          <b>{displayLabels[state?.displayMode || ""] || state?.displayMode}</b>
        </div>
        <div><small>Raw</small><b>{raw}</b></div>
      </div>
    </section>

    <div class="grid">
      <section class="card">
        <h2>Current channel</h2>
        <h3>{state?.channel?.name || "None"}</h3>
        <p class="muted">{state?.metadata || state?.channel?.url || "—"}</p>
        <button on:click={() => setChannel(null)}>Return to tuner</button>
      </section>

      <section class="card">
        <h2>Volume</h2>
        <div class="range">
          <input type="range" min="0" max="100" bind:value={volume} on:change={setVolume} />
          <b>{volume}%</b>
        </div>
      </section>
    </div>

    <section class="card">
      <h2>Virtual controls</h2>

      <div class="controls">
        <div>
          <small>Power</small>
          <ControlButton
            label="Off"
            active={((raw >> 9) & 1) === 0}
            onClick={() => setVirtualControl("power", 0)}
          />
          <ControlButton
            label="On"
            active={((raw >> 9) & 1) === 1}
            onClick={() => setVirtualControl("power", 1)}
          />
        </div>

        <div>
          <small>Bluetooth</small>
          <ControlButton
            label="Off"
            active={((raw >> 8) & 1) === 0}
            onClick={() => setVirtualControl("bluetooth", 0)}
          />
          <ControlButton
            label="On"
            active={((raw >> 8) & 1) === 1}
            onClick={() => setVirtualControl("bluetooth", 1)}
          />
        </div>

        <div>
          <small>Audio</small>
          <ControlButton
            label="Mono"
            active={((raw >> 10) & 1) === 0}
            onClick={() => setVirtualControl("mono", 0)}
          />
          <ControlButton
            label="Stereo"
            active={((raw >> 10) & 1) === 1}
            onClick={() => setVirtualControl("mono", 1)}
          />
        </div>
      </div>

      <div class="controls">
        <div>
          <small>Band</small>
          {#each state?.bands || [] as band}
            <ControlButton
              label={band.name}
              active={((raw >> 4) & 15) === band.hardware}
              onClick={() => setVirtualControl("band", band.hardware)}
            />
          {/each}
        </div>

        <div>
          <small>Display</small>
          {#each state?.displayOptions || [] as option}
            <ControlButton
              label={option.label}
              active={(raw & 15) === option.bits}
              onClick={() => setVirtualControl("display", option.bits)}
            />
          {/each}
        </div>
      </div>

      <div class="actions">
        <button class="primary" on:click={resetOverrides}>Reset everything to physical</button>
      </div>
    </section>

    <section class="card">
      <h2>Tuner</h2>
      <div class="decoded">
        <div><small>Status</small><b>{state?.tuner.ready ? "Ready" : "Unavailable"}</b></div>
        <div><small>Raw</small><b>{state?.tuner.latestRaw ?? "—"}</b></div>
        <div>
          <small>Min / Max</small>
          <b>{state?.tuner.calibration.minAngle} / {state?.tuner.calibration.maxAngle}</b>
        </div>
        <div><small>Fraction</small><b>{state?.tuner.fraction?.toFixed(3) || "—"}</b></div>
      </div>

      <div class="needle">
        <i style={`left:${(state?.tuner.fraction || 0) * 100}%`}></i>
        {#each state?.tuner.channelsInBand || [] as channel}
          <span title={channel.name}></span>
        {/each}
      </div>

      <p class="muted">
        {(state?.tuner.channelsInBand || []).map((channel) => channel.name).join(" · ") ||
          "No channels in band"}
      </p>

      <div class="actions">
        <button on:click={() => calibrate("min")}>Set min</button>
        <button on:click={() => calibrate("max")}>Set max</button>
        <button on:click={invertTuner}>
          Invert: {state?.tuner.calibration.invert ? "on" : "off"}
        </button>
      </div>
    </section>

    <div class="grid">
      <section class="card">
        <h2>Display override</h2>
        <div class="actions">
          <button on:click={() => post("/api/debug/logo-override", { ref: null })}>Normal</button>
          <button on:click={() => post("/api/debug/logo-override", { ref: "test-grid.png" })}>
            Test grid
          </button>
        </div>
      </section>

      <section class="card">
        <h2>Display tint</h2>
        <div class="range">
          <span>R</span><input type="range" min="0" max="1.5" step=".01" bind:value={tintR} />
          <b>{tintR.toFixed(2)}</b>
        </div>
        <div class="range">
          <span>G</span><input type="range" min="0" max="1.5" step=".01" bind:value={tintG} />
          <b>{tintG.toFixed(2)}</b>
        </div>
        <div class="range">
          <span>B</span><input type="range" min="0" max="1.5" step=".01" bind:value={tintB} />
          <b>{tintB.toFixed(2)}</b>
        </div>
        <div class="actions">
          <button on:click={() => applyTintPreset(1, 1, 1)}>Neutral</button>
          <button on:click={() => applyTintPreset(1.15, 0.6, 0.3)}>Ember</button>
          <button class="primary" on:click={applyTint}>Apply</button>
        </div>
      </section>
    </div>

    <section class="card">
      <h2>Channel map</h2>
      <div class="channel-grid">
        {#each state?.bands || [] as band}
          <div>
            <h3>{band.name}</h3>
            {#each (state?.channels || [])
              .filter((channel) => channel.band === band.ordinal)
              .sort((a, b) => a.order - b.order) as channel}
              <button
                class:active={state?.channel?.id === channel.id}
                on:click={() => setChannel(channel.id)}>{channel.name}</button
              >
            {/each}
          </div>
        {/each}
      </div>
    </section>

    <section class="card raw-state">
      <details>
        <summary>Advanced · Raw state JSON</summary>
        <pre>{JSON.stringify(state, null, 2)}</pre>
      </details>
    </section>

    <section class="card">
      <h2>System</h2>
      <div class="actions">
        <button
          class="danger"
          on:click={() => systemAction("/api/system/wifi-reset", "Delete saved WiFi and reboot?")}
        >
          Reset WiFi
        </button>
        <button
          class="danger"
          on:click={() => systemAction("/api/system/reboot", "Reboot the radio?")}
        >
          Reboot
        </button>
      </div>
    </section>
  </main>

  <Toast {message} {good} />
</AppShell>

<style>
  .bitline {
    display: flex;
    gap: 0.35rem;
    justify-content: center;
    flex-wrap: wrap;
  }
  .bitline span {
    display: grid;
    place-items: center;
    width: 34px;
    height: 42px;
    border: 1px solid var(--line);
    border-radius: 7px;
    font: 20px monospace;
    color: #596474;
  }
  .bitline span.on {
    color: #ffc06d;
    border-color: #f09a5477;
    background: #f09a5413;
  }
  .bitline span.control.on {
    color: var(--green);
    border-color: #69c28577;
  }
  .decoded {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
    gap: 0.7rem;
    margin-top: 1rem;
  }
  .decoded div {
    padding: 0.65rem;
    background: #0b0e1377;
    border-radius: 8px;
  }
  .decoded small {
    display: block;
    color: var(--muted);
    margin-bottom: 0.25rem;
  }
  .controls {
    display: flex;
    gap: 1rem;
    flex-wrap: wrap;
    margin-bottom: 0.7rem;
  }
  .controls > div {
    display: flex;
    gap: 0.35rem;
    align-items: center;
    flex-wrap: wrap;
  }
  .controls small {
    margin-right: 0.3rem;
    color: var(--muted);
  }
  .range {
    display: grid;
    grid-template-columns: auto 1fr 52px;
    gap: 0.7rem;
    align-items: center;
    margin: 0.5rem 0;
  }
  .needle {
    height: 40px;
    background: #090b0f;
    border-radius: 8px;
    position: relative;
    display: flex;
    overflow: hidden;
  }
  .needle span {
    flex: 1;
    border-right: 1px solid #ffffff14;
  }
  .needle i {
    position: absolute;
    top: 2px;
    bottom: 2px;
    width: 3px;
    background: var(--accent);
    z-index: 2;
  }
  .channel-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 1rem;
  }
  .channel-grid h3 {
    color: var(--accent);
  }
  .channel-grid button {
    display: block;
    width: 100%;
    text-align: left;
    margin: 0.25rem 0;
  }
  .channel-grid button.active {
    color: var(--green);
    border-color: #69c28566;
  }
  .raw-state summary {
    cursor: pointer;
    color: var(--accent);
    font-size: 0.8rem;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }
  .raw-state details[open] summary {
    margin-bottom: 0.8rem;
  }
  pre {
    font-size: 0.75rem;
    white-space: pre-wrap;
    color: var(--muted);
  }
</style>
