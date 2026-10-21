<script lang="ts">
  import { onMount } from "svelte";
  import { route } from "./lib/router";
  import { startRadioSocket } from "./lib/radio";
  import Status from "./pages/Status.svelte";
  import Wifi from "./pages/Wifi.svelte";
  import Debug from "./pages/Debug.svelte";
  import Settings from "./pages/Settings.svelte";
  import SettingsLogin from "./pages/SettingsLogin.svelte";
  onMount(startRadioSocket);
</script>

{#if $route === "/wifi"}<Wifi />
{:else if $route === "/debug"}<Debug />
{:else if $route === "/settings/login"}<SettingsLogin />
{:else if $route === "/settings"}<Settings />
{:else}<Status />{/if}
