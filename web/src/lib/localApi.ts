import { getLang } from "../i18n";
import { ApiError } from "./apiTypes";
import type { Track } from "./types";

// Your own music lives in the Musike server (web, desktop, Docker). The Android app has no such server.

export interface LocalStatus {
  folders: string[];
  tracks: number;
  scanning: boolean;
  scanned: number;
  lastScan: number | null;
  errors: number;
}

async function call<T>(path: string, init?: { method?: string; json?: unknown }): Promise<T> {
  const res = await fetch(path, {
    method: init?.method,
    headers: { "x-musike-lang": getLang(), ...(init?.json !== undefined ? { "content-type": "application/json" } : {}) },
    body: init?.json !== undefined ? JSON.stringify(init.json) : undefined,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body.error ?? `HTTP ${res.status}`, body.code);
  return body as T;
}

export const localApi = {
  status: () => call<LocalStatus>("/api/local"),
  tracks: () => call<{ tracks: Track[] }>("/api/local/tracks").then((r) => r.tracks),
  defaults: () => call<{ folders: string[] }>("/api/local/defaults").then((r) => r.folders),
  setFolders: (folders: string[]) => call<LocalStatus>("/api/local/folders", { method: "PUT", json: { folders } }),
  rescan: () => call<LocalStatus>("/api/local/scan", { method: "POST" }),
};
