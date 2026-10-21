<script lang="ts">
  export let label: string;
  export let active = false;
  export let onClick: () => void;
</script>

<button class:active on:click={onClick}>{label}</button>

<style>
  button.active {
    color: #17100a;
    background: var(--accent);
    border-color: var(--accent);
    font-weight: 750;
    box-shadow: 0 0 0 2px #f09a5426;
  }
</style>
