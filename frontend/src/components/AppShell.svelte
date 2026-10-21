<script lang="ts">
  import { route, navigate } from "../lib/router";
  export let subtitle = "Internet radio";
  const items = [["/","Status"],["/wifi","WiFi"],["/debug","Debug"],["/settings","Settings"]];
  function go(event:MouseEvent, path:string){ event.preventDefault(); navigate(path); }
</script>

<header class="app-header">
  <a class="brand" href="/" on:click={(e)=>go(e,"/")}>RADIONETTE</a>
  <div class="brand-sub">{subtitle}</div>
  <nav class="tabs">
    {#each items as item}
      <a class:active={$route === item[0] || (item[0] === "/settings" && $route.startsWith("/settings"))} class="tab" href={item[0]} on:click={(e)=>go(e,item[0])}>{item[1]}</a>
    {/each}
  </nav>
</header>
<slot />
