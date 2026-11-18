export interface Track {
  id: string;
  title: string;
  artist: string;
  album?: string;
  duration: number;
  thumb: string;
  art: string;
  kind: "song" | "video";
  /** "local" for files from the user's own folders; absent means YouTube. */
  source?: "local";
}

export interface Playlist {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  tracks: Track[];
}

export interface Library {
  favorites: Track[];
  playlists: Playlist[];
  history: Track[];
}

import { tr, type Text } from "./i18n.js";

export const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
/** Music from the user's own folders: "loc_" and 16 hex digits (a hash of the file's path). */
export const LOCAL_ID = /^loc_[0-9a-f]{16}$/;
/** Any track Musike can hold: a YouTube video or a local file. */
export const isTrackId = (id: string) => VIDEO_ID.test(id) || LOCAL_ID.test(id);

/** Machine-readable reason so the web app can offer the right fix (e.g. "update yt-dlp"). */
export type ErrorCode = "tool_missing" | "maybe_outdated" | "bot_check";

/** An error for the person using the app: its text is translated into each request's language when sent. */
export class HttpError extends Error {
  constructor(
    public status: number,
    public text: Text,
    public code?: ErrorCode,
  ) {
    super(tr("en", text));
  }
}
