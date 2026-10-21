<script lang="ts">
  import type { Band, Channel } from "../../types";

  export let bands: Band[];
  export let channels: Channel[];
  export let onAdd: () => void;
  export let onRemove: (index: number) => void;
  export let onSave: () => void;
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
          <td><input bind:value={channel.logo} placeholder="generated" /></td>
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
    min-width: 1000px;
  }
</style>
