import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [svelte()],
  build: {
    outDir: fileURLToPath(new URL("../dist/public", import.meta.url)),
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": "http://radionette.local:8080",
      "/logos": "http://radionette.local:8080",
      "/socket": { target: "ws://radionette.local:8080", ws: true },
    },
  },
});
