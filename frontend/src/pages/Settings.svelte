<script lang="ts">
  import { onMount } from "svelte";
  import AppShell from "../components/AppShell.svelte";
  import BandsEditor from "../components/settings/BandsEditor.svelte";
  import StationsEditor from "../components/settings/StationsEditor.svelte";
  import Toast from "../components/Toast.svelte";
  import { api } from "../lib/api";
  import { navigate } from "../lib/router";
  import type { SettingsBundle, DisplayMapping } from "../types";

  let model: SettingsBundle | null = null;
  let message = "";
  let good = true;
  let importFile: File | null = null;
  let currentPin = "";
  let newPin = "";
  let confirmPin = "";
  let spotifyApiKey = "";
  const displayFields: Array<[keyof DisplayMapping, string]> = [
    ["autoArtwork", "Auto · logo + artwork"],
    ["autoLogo", "Auto · logo only"],
    ["alwaysArtwork", "Always on · logo + artwork"],
    ["alwaysLogo", "Always on · logo only"],
    ["off", "Display off"],
  ];
  onMount(load);
  async function load() {
    try {
      model = await api("/api/settings");
    } catch (e) {
      notify((e as Error).message, false);
    }
  }
  function notify(v: string, ok = true) {
    message = v;
    good = ok;
    setTimeout(() => (message = ""), 4500);
  }
  function touch() {
    if (model)
      model = {
        ...model,
        channels: { bands: [...model.channels.bands], channels: [...model.channels.channels] },
      };
  }
  function addBand() {
    if (!model) return;
    const ordinal = Math.max(0, ...model.channels.bands.map((b) => b.ordinal)) + 1;
    const used = new Set(Object.values(model.bandMapping));
    let hardware = 0;
    while (used.has(hardware) && hardware < 15) hardware++;
    model.channels.bands.push({ ordinal, name: `Band ${ordinal}`, hardware });
    model.bandMapping[String(ordinal)] = hardware;
    touch();
  }
  function removeBand(index: number) {
    if (!model) return;
    const band = model.channels.bands[index];
    if (!confirm(`Remove ${band.name} and all its stations?`)) return;
    model.channels.bands.splice(index, 1);
    model.channels.channels = model.channels.channels.filter((c) => c.band !== band.ordinal);
    delete model.bandMapping[String(band.ordinal)];
    touch();
  }
  function addStation() {
    if (!model?.channels.bands.length) return;
    const n = model.channels.channels.length + 1;
    model.channels.channels.push({
      id: `station-${n}`,
      name: "New station",
      band: model.channels.bands[0].ordinal,
      order: n * 10,
      url: "https://",
    });
    touch();
  }
  function removeStation(index: number) {
    if (!model) return;
    model.channels.channels.splice(index, 1);
    touch();
  }
  async function saveStations() {
    if (!model) return;
    try {
      model.channels.bands.forEach(
        (b) => (b.hardware = Number(model!.bandMapping[String(b.ordinal)] ?? b.hardware)),
      );
      const r: any = await api("/api/settings/channels", {
        method: "PUT",
        body: JSON.stringify(model.channels),
      });
      model.channels = r.channels;
      touch();
      notify("Bands and stations saved");
    } catch (e) {
      notify((e as Error).message, false);
    }
  }
  async function capture(which: "band" | keyof DisplayMapping, ordinal?: number) {
    if (!model) return;
    try {
      const s: any = await api("/api/status");
      model.rawGpio = s.rawGpio || 0;
      if (which === "band" && ordinal !== undefined)
        model.bandMapping[String(ordinal)] = (model.rawGpio >> 4) & 15;
      else {
        if (!model.displayMapping)
          model.displayMapping = {
            autoArtwork: 0,
            autoLogo: 2,
            alwaysArtwork: 1,
            alwaysLogo: 4,
            off: 8,
          };
        model.displayMapping[which as keyof DisplayMapping] = model.rawGpio & 15;
      }
      model = { ...model };
    } catch (e) {
      notify((e as Error).message, false);
    }
  }
  async function saveBandMapping() {
    if (!model) return;
    try {
      const r: any = await api("/api/settings/band-mapping", {
        method: "PUT",
        body: JSON.stringify(model.bandMapping),
      });
      model.bandMapping = r.bandMapping;
      model = { ...model };
      notify("Band mapping saved");
    } catch (e) {
      notify((e as Error).message, false);
    }
  }
  async function saveDisplayMapping() {
    if (!model?.displayMapping) return notify("Capture or enter all display values first", false);
    try {
      const r: any = await api("/api/settings/display-mapping", {
        method: "PUT",
        body: JSON.stringify(model.displayMapping),
      });
      model.displayMapping = r.displayMapping;
      model = { ...model };
      notify("Display mapping saved");
    } catch (e) {
      notify((e as Error).message, false);
    }
  }

  function updateDisplayMapping(key: keyof DisplayMapping, value: string) {
    if (!model) return;
    if (!model.displayMapping) {
      model.displayMapping = {
        autoArtwork: 0,
        autoLogo: 2,
        alwaysArtwork: 1,
        alwaysLogo: 4,
        off: 8,
      };
    }
    model.displayMapping[key] = Number(value);
    model = { ...model };
  }

  function updateTint(channel: "r" | "g" | "b", value: string) {
    if (!model) return;
    model.displayPreferences.tint[channel] = Number(value);
    model = { ...model };
  }

  function selectImportFile(event: Event) {
    importFile = (event.currentTarget as HTMLInputElement).files?.[0] || null;
  }

  function setTint(r: number, g: number, b: number) {
    if (!model) return;
    model.displayPreferences.tint = { r, g, b };
    model = { ...model };
  }
  async function saveTint() {
    if (!model) return;
    try {
      const r: any = await api("/api/settings/tint", {
        method: "PUT",
        body: JSON.stringify(model.displayPreferences.tint),
      });
      model.displayPreferences.tint = r.tint;
      model = { ...model };
      notify("Default tint saved");
    } catch (e) {
      notify((e as Error).message, false);
    }
  }
  async function saveSpotify() {
    if (!model) return;
    try {
      const r: any = await api("/api/settings/spotify", {
        method: "PUT",
        body: JSON.stringify({
          ...(spotifyApiKey.trim() ? { apiKey: spotifyApiKey } : {}),
          bandOrdinal: model.spotify.bandOrdinal,
        }),
      });
      model.spotify = r.spotify;
      spotifyApiKey = "";
      model = { ...model };
      notify("Spotify Soloist configured");
    } catch (e) {
      notify((e as Error).message, false);
    }
  }
  async function clearSpotifyKey() {
    if (!model?.spotify.configured) return;
    if (!confirm("Clear the Spotify Soloist API key from this radio?")) return;
    try {
      const r: any = await api("/api/settings/spotify", { method: "DELETE" });
      model.spotify = r.spotify;
      spotifyApiKey = "";
      model = { ...model };
      notify("Spotify API key cleared");
    } catch (e) {
      notify((e as Error).message, false);
    }
  }
  async function importSettings() {
    if (!importFile) return notify("Choose a JSON backup first", false);
    if (!confirm("Replace this radio's local settings?")) return;
    try {
      const value = JSON.parse(await importFile.text());
      const r: any = await api("/api/settings/import", {
        method: "POST",
        body: JSON.stringify(value),
      });
      model = r.settings;
      notify("Settings imported");
    } catch (e) {
      notify((e as Error).message, false);
    }
  }
  async function changePin() {
    if (newPin !== confirmPin) return notify("New PIN entries do not match", false);
    try {
      await api("/api/settings/pin", {
        method: "PUT",
        body: JSON.stringify({ currentPin, newPin }),
      });
      alert("PIN changed. Sign in again.");
      navigate("/settings/login");
    } catch (e) {
      notify((e as Error).message, false);
    }
  }
  async function logout() {
    await fetch("/api/settings/logout", { method: "POST" });
    navigate("/settings/login");
  }
</script>

<AppShell subtitle="Configuration">
  <main class="page">
    {#if !model}
      <section class="card"><p>Loading settings…</p></section>
    {:else}
      <BandsEditor bands={model.channels.bands} onAdd={addBand} onRemove={removeBand} />
      <StationsEditor
        bands={model.channels.bands}
        channels={model.channels.channels}
        onAdd={addStation}
        onRemove={removeStation}
        onSave={saveStations}
      />
      <div class="grid">
        <section class="card">
          <h2>Band hardware mapping</h2>
          {#each model.channels.bands as band}
            <div class="mapping">
              <span>{band.name}</span>
              <input
                type="number"
                min="0"
                max="15"
                bind:value={model.bandMapping[String(band.ordinal)]}
              />
              <button on:click={() => capture("band", band.ordinal)}>Capture</button>
            </div>
          {/each}
          <div class="actions">
            <button class="primary" on:click={saveBandMapping}>Save mapping</button>
          </div>
          <small>Current top nibble: 0x{((model.rawGpio >> 4) & 15).toString(16)}</small>
        </section>

        <section class="card">
          <h2>Display hardware mapping</h2>
          {#each displayFields as field}
            <div class="mapping">
              <span>{field[1]}</span>
              <input
                type="number"
                min="0"
                max="15"
                value={model.displayMapping?.[field[0]] ?? ""}
                on:input={(event) => updateDisplayMapping(field[0], event.currentTarget.value)}
              />
              <button on:click={() => capture(field[0])}>Capture</button>
            </div>
          {/each}
          <div class="actions">
            <button class="primary" on:click={saveDisplayMapping}>Save mapping</button>
          </div>
          <small>Current lower nibble: 0x{(model.rawGpio & 15).toString(16)}</small>
        </section>
      </div>

      <section class="card">
        <h2>Default display tint</h2>
        {#each [["R", "r"], ["G", "g"], ["B", "b"]] as item}
          <div class="tint">
            <b>{item[0]}</b>
            <input
              type="range"
              min="0"
              max="2"
              step=".01"
              value={model.displayPreferences.tint[item[1] as "r" | "g" | "b"]}
              on:input={(event) =>
                updateTint(item[1] as "r" | "g" | "b", event.currentTarget.value)}
            />
            <span>{model.displayPreferences.tint[item[1] as "r" | "g" | "b"].toFixed(2)}</span>
          </div>
        {/each}
        <div class="actions">
          <button on:click={() => setTint(1, 1, 1)}>Neutral</button>
          <button on:click={() => setTint(1.05, 0.9, 0.7)}>Warm</button>
          <button on:click={() => setTint(1.1, 0.75, 0.5)}>Retro</button>
          <button on:click={() => setTint(1.15, 0.6, 0.3)}>Ember</button>
          <button class="primary" on:click={saveTint}>Save default</button>
        </div>
      </section>

      <section class="card">
        <h2>Spotify Connect</h2>
        <p>
          Band 4 uses Spotify’s official Soloist player. Generate a private key in the
          <a href="https://developer.spotify.com/dashboard/soloist" target="_blank" rel="noreferrer"
            >Spotify Soloist dashboard</a
          >, then save it here.
        </p>
        <label>
          Soloist API key
          <input
            type="password"
            autocomplete="off"
            placeholder={model.spotify.configured
              ? "Configured — paste to replace"
              : "Paste API key"}
            bind:value={spotifyApiKey}
          />
        </label>
        <label>
          Spotify band
          <select bind:value={model.spotify.bandOrdinal}>
            {#each model.channels.bands as band}
              <option value={band.ordinal}>{band.name} · Band {band.ordinal}</option>
            {/each}
          </select>
        </label>
        <div class="actions">
          <button class="primary" on:click={saveSpotify}>Save Spotify settings</button>
          <button class="danger" disabled={!model.spotify.configured} on:click={clearSpotifyKey}
            >Clear Spotify key</button
          >
          <span class="pill">{model.spotify.configured ? "Configured" : "Not configured"}</span>
        </div>
        <small>The key stays on this radio and is excluded from settings exports.</small>
      </section>

      <section class="card">
        <h2>Backup and restore</h2>
        <div class="actions">
          <a class="button" href="/api/settings/export">Export settings</a>
          <input type="file" accept=".json,application/json" on:change={selectImportFile} />
          <button class="danger" on:click={importSettings}>Validate and import</button>
        </div>
      </section>

      <section class="card">
        <h2>Security</h2>
        <div class="grid">
          <label>Current PIN<input type="password" bind:value={currentPin} /></label>
          <label>New PIN<input type="password" bind:value={newPin} /></label>
          <label>Confirm PIN<input type="password" bind:value={confirmPin} /></label>
        </div>
        <div class="actions">
          <button class="primary" on:click={changePin}>Change PIN</button>
          <button on:click={logout}>Log out</button>
        </div>
      </section>
    {/if}
  </main>

  <Toast {message} {good} />
</AppShell>

<style>
  .mapping {
    display: grid;
    grid-template-columns: 1fr 90px auto;
    gap: 0.5rem;
    align-items: center;
    margin: 0.45rem 0;
  }
  .tint {
    display: grid;
    grid-template-columns: 25px 1fr 55px;
    gap: 0.6rem;
    align-items: center;
    margin: 0.6rem 0;
  }
  label {
    color: var(--muted);
  }
  label input {
    margin-top: 0.35rem;
  }
  @media (max-width: 600px) {
    .mapping {
      grid-template-columns: 1fr 70px;
    }
    .mapping button {
      grid-column: 1/-1;
    }
  }
</style>
