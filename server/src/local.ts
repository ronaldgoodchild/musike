import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "./config.js";
import { msg } from "./i18n.js";
import { serveFile } from "./stream.js";
import { HttpError, LOCAL_ID, type Track } from "./types.js";

/**
 * Your own music: folders on this computer (or mounted into the Docker container) are scanned for audio files.
 * Node-only on purpose: the Android app has no local folders, so native/api.ts never imports this module.
 */

const AUDIO_TYPES: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".flac": "audio/flac",
  ".m4a": "audio/mp4",
  ".m4b": "audio/mp4",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/ogg",
  ".wav": "audio/wav",
  ".wma": "audio/x-ms-wma",
  ".aiff": "audio/aiff",
  ".ape": "audio/x-ape",
};
const COVER_NAMES = ["cover", "folder", "front", "album", "albumart"];
const COVER_EXTS = [".jpg", ".jpeg", ".png", ".webp"];
const MAX_FOLDERS = 20;
const MAX_TRACKS = 100_000;

interface Entry {
  id: string;
  file: string;
  title: string;
  artist: string;
  album: string;
  duration: number;
  year: number;
  trackNo: number;
  /** Where this file's cover lives: embedded in the tags, or a picture next to it. */
  cover: "embedded" | string | null;
  added: number;
}

export interface LocalStatus {
  folders: string[];
  tracks: number;
  scanning: boolean;
  scanned: number;
  lastScan: number | null;
  errors: number;
}

interface Saved {
  folders: string[];
  lastScan: number | null;
  entries: Entry[];
  /** File → last-modified time at the last scan, so unchanged files are not read again. */
  stamps?: [string, number][];
}

const settingsFile = () => path.join(config.dataDir, "local.json");

let saved: Saved | null = null;
let byId = new Map<string, Entry>();
let scanning: Promise<void> | null = null;
let scanned = 0;
let errors = 0;

async function load(): Promise<Saved> {
  if (saved) return saved;
  try {
    saved = JSON.parse(await readFile(settingsFile(), "utf8")) as Saved;
    saved.folders ??= [];
    saved.entries ??= [];
  } catch {
    saved = { folders: [], lastScan: null, entries: [] };
  }
  byId = new Map(saved.entries.map((e) => [e.id, e]));
  return saved;
}

async function persist() {
  await mkdir(config.dataDir, { recursive: true });
  const tmp = `${settingsFile()}.tmp`;
  await writeFile(tmp, JSON.stringify(saved), "utf8");
  await rename(tmp, settingsFile());
}

const idFor = (file: string) =>
  `loc_${createHash("sha1").update(path.resolve(file).toLowerCase()).digest("hex").slice(0, 16)}`;

function toTrack(e: Entry): Track {
  const art = e.cover ? `/api/local/art/${e.id}` : "";
  return { id: e.id, title: e.title, artist: e.artist, album: e.album || undefined, duration: e.duration, thumb: art, art, kind: "song", source: "local" };
}

export async function status(): Promise<LocalStatus> {
  const s = await load();
  return { folders: s.folders, tracks: s.entries.length, scanning: !!scanning, scanned, lastScan: s.lastScan, errors };
}

export async function tracks(): Promise<{ tracks: Track[]; years: Record<string, number> }> {
  const s = await load();
  const sorted = [...s.entries].sort(
    (a, b) => a.artist.localeCompare(b.artist) || a.album.localeCompare(b.album) || a.trackNo - b.trackNo || a.title.localeCompare(b.title),
  );
  return { tracks: sorted.map(toTrack), years: Object.fromEntries(sorted.filter((e) => e.year).map((e) => [e.album || e.title, e.year])) };
}

export async function setFolders(input: unknown): Promise<LocalStatus> {
  if (!Array.isArray(input)) throw new HttpError(400, msg("localFolderInvalid"));
  if (input.length > MAX_FOLDERS) throw new HttpError(400, msg("localTooMany"));
  const folders: string[] = [];
  for (const raw of input) {
    if (typeof raw !== "string" || !raw.trim()) continue;
    const dir = path.resolve(raw.trim());
    const info = await stat(dir).catch(() => null);
    if (!info?.isDirectory()) throw new HttpError(400, msg("localFolderInvalid"));
    if (!folders.includes(dir)) folders.push(dir);
  }
  const s = await load();
  s.folders = folders;
  // Files outside the chosen folders leave the library at once; the rescan finds the rest.
  s.entries = s.entries.filter((e) => folders.some((f) => isInside(f, e.file)));
  byId = new Map(s.entries.map((e) => [e.id, e]));
  await persist();
  void startScan();
  return status();
}

const isInside = (folder: string, file: string) => {
  const rel = path.relative(folder, file);
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
};

async function* walk(dir: string): AsyncGenerator<{ file: string; siblings: string[] }> {
  let items;
  try {
    items = await readdir(dir, { withFileTypes: true });
  } catch {
    errors++;
    return;
  }
  const siblings = items.filter((i) => i.isFile()).map((i) => i.name);
  for (const item of items) {
    if (item.name.startsWith(".")) continue;
    const full = path.join(dir, item.name);
    if (item.isDirectory()) yield* walk(full);
    else if (item.isFile() && AUDIO_TYPES[path.extname(item.name).toLowerCase()]) yield { file: full, siblings };
  }
}

function coverBeside(dir: string, siblings: string[]): string | null {
  for (const name of siblings) {
    const ext = path.extname(name).toLowerCase();
    if (COVER_EXTS.includes(ext) && COVER_NAMES.includes(path.basename(name, ext).toLowerCase())) return path.join(dir, name);
  }
  return null;
}

/** "01 - Title" / "Artist - Title" file names, for files with no tags at all. */
function fromFileName(file: string) {
  const base = path
    .basename(file, path.extname(file))
    .replace(/_/g, " ")
    .replace(/^\d{1,3}[\s.\-)]+(?=\D)/, "") // leading track number
    .trim();
  const m = /^(.+?)\s+-\s+(.+)$/.exec(base);
  return m ? { artist: m[1].trim(), title: m[2].trim() } : { artist: "", title: base };
}

async function readEntry(file: string, siblings: string[], known: Entry | undefined, mtime: number): Promise<Entry> {
  const { parseFile } = await import("music-metadata");
  const guess = fromFileName(file);
  const beside = coverBeside(path.dirname(file), siblings);
  try {
    const meta = await parseFile(file, { duration: true, skipPostHeaders: true });
    const c = meta.common;
    return {
      id: idFor(file),
      file,
      title: (c.title || guess.title).slice(0, 300),
      artist: (c.artist || c.albumartist || guess.artist || "Unknown artist").slice(0, 300),
      album: (c.album || path.basename(path.dirname(file))).slice(0, 300),
      duration: Math.round(meta.format.duration ?? 0),
      year: c.year ?? 0,
      trackNo: c.track?.no ?? 0,
      cover: c.picture?.length ? "embedded" : beside,
      added: known?.added ?? mtime,
    };
  } catch {
    errors++;
    return { id: idFor(file), file, title: guess.title, artist: guess.artist || "Unknown artist", album: path.basename(path.dirname(file)), duration: 0, year: 0, trackNo: 0, cover: beside, added: known?.added ?? mtime };
  }
}

/** Walks every folder and updates the index. Files that haven't changed since the last scan are not read again. */
export function startScan(): Promise<void> {
  if (scanning) return scanning;
  scanning = (async () => {
    const s = await load();
    scanned = 0;
    errors = 0;
    const old = new Map(s.entries.map((e) => [e.file, e]));
    const stamps = new Map<string, number>(s.stamps ?? []);
    const next: Entry[] = [];
    const seen = new Set<string>();
    for (const folder of s.folders) {
      for await (const { file, siblings } of walk(folder)) {
        if (next.length >= MAX_TRACKS) break;
        if (seen.has(file)) continue;
        seen.add(file);
        const mtime = (await stat(file).catch(() => null))?.mtimeMs ?? 0;
        const known = old.get(file);
        next.push(known && stamps.get(file) === mtime ? known : await readEntry(file, siblings, known, mtime));
        stamps.set(file, mtime);
        scanned++;
      }
    }
    s.entries = next;
    s.lastScan = Date.now();
    s.stamps = [...stamps].filter(([f]) => seen.has(f));
    byId = new Map(next.map((e) => [e.id, e]));
    await persist();
  })().finally(() => {
    scanning = null;
  });
  return scanning;
}

async function entryFor(id: string): Promise<Entry> {
  await load();
  const e = LOCAL_ID.test(id) ? byId.get(id) : undefined;
  if (!e || !existsSync(e.file)) throw new HttpError(404, msg("localNotFound"));
  return e;
}

/** Streams the file itself (with Range, so seeking works). Only files the scan found can be asked for. */
export async function serveAudio(req: FastifyRequest, reply: FastifyReply, id: string) {
  const e = await entryFor(id);
  return serveFile(req, reply, e.file, AUDIO_TYPES[path.extname(e.file).toLowerCase()] ?? "application/octet-stream");
}

export async function serveArt(reply: FastifyReply, id: string) {
  const e = await entryFor(id);
  if (!e.cover) throw new HttpError(404, msg("localNotFound"));
  reply.header("cache-control", "public, max-age=86400");
  if (e.cover !== "embedded") {
    reply.header("content-type", e.cover.endsWith(".png") ? "image/png" : e.cover.endsWith(".webp") ? "image/webp" : "image/jpeg");
    return reply.send(await readFile(e.cover));
  }
  const { parseFile, selectCover } = await import("music-metadata");
  const meta = await parseFile(e.file, { skipPostHeaders: true });
  const pic = selectCover(meta.common.picture);
  if (!pic) throw new HttpError(404, msg("localNotFound"));
  reply.header("content-type", pic.format);
  return reply.send(Buffer.from(pic.data));
}

export const isLocalId = (id: string) => LOCAL_ID.test(id);

/** Where the first scan starts when the user has not chosen anything: their Music folder, if it exists. */
export async function defaultFolders(): Promise<string[]> {
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const music = home ? path.join(home, "Music") : "";
  return music && (await stat(music).catch(() => null))?.isDirectory() ? [music] : [];
}
