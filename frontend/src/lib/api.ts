import { navigate } from "./router";

export async function api<T = any>(url: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(url, { ...options, headers });
  if (response.status === 401 && url.startsWith("/api/settings") && url !== "/api/settings/login") {
    navigate("/settings/login");
    throw new Error("Settings session expired");
  }
  const type = response.headers.get("content-type") || "";
  const data: any = type.includes("json") ? await response.json() : await response.text();
  if (!response.ok || data?.success === false)
    throw new Error(data?.error || `HTTP ${response.status}`);
  return data as T;
}
