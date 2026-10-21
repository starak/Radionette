import { writable } from "svelte/store";

export const route = writable(typeof window === "undefined" ? "/" : window.location.pathname);

export function navigate(path:string):void {
  if (window.location.pathname !== path) history.pushState({}, "", path);
  route.set(path);
  window.scrollTo({ top:0, behavior:"instant" });
}

if (typeof window !== "undefined") {
  window.addEventListener("popstate", () => route.set(window.location.pathname));
}
