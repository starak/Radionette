<script lang="ts">export let message="";export let good=true;</script>
{#if message}<div class:bad={!good} class="toast">{message}</div>{/if}
