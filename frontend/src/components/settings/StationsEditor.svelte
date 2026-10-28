<script lang="ts">
  import type { Band, Channel } from "../../types";

  export let bands: Band[];
  export let channels: Channel[];
  export let onAdd: () => void;
  export let onRemove: (index: number) => void;
  export let onSave: () => void;
  export let onUploadLogo: (index: number, file: File) => Promise<void>;

  async function uploadLogo(index: number, event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    await onUploadLogo(index, file);
    input.value = "";
  }
</script>

<section class="card stations">
  <h2>Stations</h2>
  <table>
    <thead>
      <tr>
        <th>ID</th><th>Name</th><th>Band</th><th>Order</th><th>Stream URL</th><th>Logo</th><th></th>
      </tr>
    </thead>
    <tbody>
      {#each channels as channel, index}
        <tr>
          <td><input bind:value={channel.id} /></td>
          <td><input bind:value={channel.name} /></td>
          <td>
            <select bind:value={channel.band}>
              {#each bands as band}
                <option value={band.ordinal}>{band.ordinal}: {band.name}</option>
              {/each}
            </select>
          </td>
          <td><input type="number" bind:value={channel.order} /></td>
          <td><input bind:value={channel.url} /></td>
          <td class="logo-cell">
            <label class="logo-picker" title="Upload a custom logo">
              <span class:placeholder={!channel.logo}>{channel.logo || "Upload logo"}</span>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M5 14v5h14v-5" />
              </svg>
              <input
                class="file-input"
                type="file"
                accept="image/png,image/jpeg,image/gif,.png,.jpg,.jpeg,.gif"
                on:change={(event) => uploadLogo(index, event)}
              />
            </label>
          </td>
          <td><button class="danger" on:click={() => onRemove(index)}>×</button></td>
        </tr>
      {/each}
    </tbody>
  </table>
  <div class="actions">
    <button on:click={onAdd}>Add station</button>
    <button class="primary" on:click={onSave}>Save bands and stations</button>
  </div>
</section>

<style>
  .stations {
    overflow: auto;
  }
  table {
    min-width: 1120px;
  }
  .logo-cell {
    min-width: 210px;
  }
  .logo-picker {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 20px;
    gap: 0.5rem;
    align-items: center;
    width: 100%;
    min-height: 39px;
    padding: 0.5rem 0.65rem;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: #080b10;
    color: #d7dde6;
    cursor: pointer;
    font-size: 0.82rem;
  }
  .logo-picker:hover,
  .logo-picker:focus-within {
    border-color: var(--accent);
  }
  .logo-picker span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .logo-picker span.placeholder {
    color: var(--muted);
  }
  .logo-picker svg {
    width: 19px;
    height: 19px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.8;
    stroke-linecap: round;
    stroke-linejoin: round;
    color: var(--accent);
  }
  .file-input {
    display: none;
  }
</style>
