<script lang="ts">
  import AppShell from "../components/AppShell.svelte";import { api } from "../lib/api";import { navigate } from "../lib/router";
  let pin="",error="";
  async function login(){error="";try{await api("/api/settings/login",{method:"POST",body:JSON.stringify({pin})});navigate("/settings")}catch(e){error=(e as Error).message;pin=""}}
</script>
<AppShell subtitle="Configuration"><main class="login"><form class="card" on:submit|preventDefault={login}><h2>Settings</h2><p>Enter the administration PIN.</p><input bind:value={pin} type="password" inputmode="numeric" minlength="4" maxlength="12" autocomplete="current-password" placeholder="PIN" required><button class="primary">Unlock settings</button>{#if error}<p class="error">{error}</p>{/if}</form></main></AppShell>
<style>.login{width:min(380px,100%);margin:12vh auto}.card{padding:1.3rem}.card button{width:100%;margin-top:.7rem}.error{color:#ff9b95}</style>
