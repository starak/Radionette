<script lang="ts">
  import type { Band } from "../../types";

  export let bands: Band[];
  export let onAdd: () => void;
  export let onRemove: (index: number) => void;
</script>

<section class="card">
  <h2>Bands</h2>
  <table>
    <thead>
      <tr><th>Ordinal</th><th>Name</th><th></th></tr>
    </thead>
    <tbody>
      {#each bands as band, index}
        <tr>
          <td>{band.ordinal}</td>
          <td><input bind:value={band.name} /></td>
          <td><button class="danger" on:click={() => onRemove(index)}>Remove</button></td>
        </tr>
      {/each}
    </tbody>
  </table>
  <div class="actions"><button on:click={onAdd}>Add band</button></div>
</section>
