import { ArrowLeftIcon, ArrowsClockwiseIcon, FolderOpenIcon, FolderPlusIcon, MusicNotesIcon, PlayIcon, ShuffleIcon, TrashIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Artwork } from "../components/Artwork";
import { IconButton, PlayDisc } from "../components/IconButton";
import { EmptyState, PageHeader } from "../components/Page";
import { TrackList, TrackListSkeleton } from "../components/TrackList";
import { useT } from "../i18n";
import { desktop } from "../lib/desktop";
import { cn, shuffled } from "../lib/format";
import { localApi, type LocalStatus } from "../lib/localApi";
import type { Track } from "../lib/types";
import { usePlayer } from "../player/player";
import { toast } from "../stores/ui";

type Tab = "songs" | "albums" | "artists";

interface Group {
  key: string;
  title: string;
  sub: string;
  tracks: Track[];
}

function groupBy(tracks: Track[], by: "album" | "artist"): Group[] {
  const map = new Map<string, Group>();
  for (const t of tracks) {
    const title = (by === "album" ? t.album : t.artist) || "—";
    // Albums with the same name by different artists stay apart.
    const key = by === "album" ? `${title}\u0000${t.artist}` : title;
    let g = map.get(key);
    if (!g) map.set(key, (g = { key, title, sub: by === "album" ? t.artist : "", tracks: [] }));
    g.tracks.push(t);
  }
  return [...map.values()].sort((a, b) => a.title.localeCompare(b.title));
}

function FolderManager({ status, onChange }: { status: LocalStatus; onChange: (s: LocalStatus) => void }) {
  const t = useT();
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const pickFolder = desktop?.pickFolder;

  const save = async (folders: string[]) => {
    setBusy(true);
    try {
      onChange(await localApi.setFolders(folders));
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  const add = async (dir: string) => {
    const clean = dir.trim().replace(/^"|"$/g, "");
    if (clean && !status.folders.includes(clean)) await save([...status.folders, clean]);
    setPath("");
  };

  return (
    <section className="mx-4 mt-2 flex flex-col gap-3 rounded-[16px] bg-surface-1 p-4 ring-1 ring-line md:mx-6">
      <h2 className="font-semibold tracking-tight">{t.local.foldersTitle}</h2>
      <p className="text-sm text-fg-2">{t.local.foldersHelp}</p>
      {status.folders.length > 0 && (
        <ul className="flex flex-col gap-1">
          {status.folders.map((f) => (
            <li key={f} className="flex items-center gap-2 rounded-[10px] bg-surface-2 px-3 py-1.5 text-sm">
              <FolderOpenIcon size={18} className="shrink-0 text-accent-text" />
              <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{f}</span>
              <IconButton label={t.local.remove} size="sm" disabled={busy} onClick={() => save(status.folders.filter((x) => x !== f))}>
                <TrashIcon size={16} />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void add(path);
        }}
      >
        <input
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder={t.local.pathPlaceholder}
          aria-label={t.local.addFolder}
          className="h-11 min-w-0 flex-1 basis-60 rounded-full bg-bg px-4 text-sm ring-1 ring-line outline-none focus:ring-accent"
        />
        {pickFolder && (
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              const dir = await pickFolder();
              if (dir) await add(dir);
            }}
            className="h-11 rounded-full bg-surface-3 px-5 text-sm font-medium hover:bg-surface-4 disabled:opacity-50"
          >
            {t.local.browse}
          </button>
        )}
        <button
          type="submit"
          disabled={busy || !path.trim()}
          className="flex h-11 items-center gap-2 rounded-full bg-accent px-5 text-sm font-semibold text-accent-ink disabled:opacity-40"
        >
          <FolderPlusIcon size={18} /> {t.local.addFolder}
        </button>
      </form>
    </section>
  );
}

export default function Local() {
  const t = useT();
  const playList = usePlayer((s) => s.playList);
  const [status, setStatus] = useState<LocalStatus | null>(null);
  const [tracks, setTracks] = useState<Track[] | null>(null);
  const [tab, setTab] = useState<Tab>("songs");
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState<Group | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [s, list] = await Promise.all([localApi.status(), localApi.tracks()]);
      setStatus(s);
      setTracks(list);
      return s;
    } catch (e) {
      toast((e as Error).message, "error");
      setTracks([]);
      return null;
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // While a scan runs, poll its progress and show the new list when it finishes.
  const scanning = status?.scanning ?? false;
  useEffect(() => {
    if (!scanning) return;
    const timer = setInterval(async () => {
      const s = await localApi.status().catch(() => null);
      if (!s) return;
      setStatus(s);
      if (!s.scanning) void refresh();
    }, 1200);
    return () => clearInterval(timer);
  }, [scanning, refresh]);

  const needle = filter.trim().toLocaleLowerCase();
  const visible = useMemo(
    () => (tracks ?? []).filter((x) => !needle || `${x.title} ${x.artist} ${x.album ?? ""}`.toLocaleLowerCase().includes(needle)),
    [tracks, needle],
  );
  const groups = useMemo(() => (tab === "songs" ? [] : groupBy(visible, tab === "albums" ? "album" : "artist")), [visible, tab]);
  const shown = open ? open.tracks : visible;
  const empty = !!status && status.folders.length === 0;

  const tabButton = (id: Tab, label: string) => (
    <button
      key={id}
      type="button"
      onClick={() => {
        setTab(id);
        setOpen(null);
      }}
      className={cn("h-9 rounded-full px-4 text-sm font-medium transition-colors", tab === id ? "bg-accent text-accent-ink" : "bg-surface-3 text-fg-2 hover:text-fg")}
    >
      {label}
    </button>
  );

  return (
    <div className="pb-8">
      <PageHeader
        title={t.local.title}
        actions={
          status && status.folders.length > 0 ? (
            <IconButton
              label={t.local.rescan}
              disabled={scanning}
              onClick={async () => setStatus(await localApi.rescan().catch(() => status))}
            >
              <ArrowsClockwiseIcon size={20} className={cn(scanning && "animate-spin")} />
            </IconButton>
          ) : undefined
        }
      />

      <p className="px-4 pt-1 text-sm text-fg-2 md:px-6">
        {scanning ? t.local.scanning(status?.scanned ?? 0) : status && status.tracks > 0 ? t.local.lastScan(status.tracks) : t.local.subtitle}
      </p>

      {status && <FolderManager status={status} onChange={(s) => { setStatus(s); void refresh(); }} />}

      {tracks === null && (
        <div className="px-4 pt-6 md:px-6">
          <TrackListSkeleton />
        </div>
      )}

      {tracks !== null && tracks.length === 0 && !scanning && (
        <EmptyState icon={<MusicNotesIcon size={28} />} title={t.local.emptyTitle} body={t.local.emptyBody} />
      )}

      {tracks !== null && tracks.length > 0 && !empty && (
        <>
          <div className="flex flex-wrap items-center gap-2 px-4 pt-5 md:px-6">
            {tabButton("songs", t.local.songs)}
            {tabButton("albums", t.local.albums)}
            {tabButton("artists", t.local.artists)}
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={t.local.filter}
              aria-label={t.local.filter}
              className="ml-auto h-9 w-full max-w-64 rounded-full bg-bg px-4 text-sm ring-1 ring-line outline-none focus:ring-accent sm:w-64"
            />
          </div>

          {(tab === "songs" || open) && (
            <>
              <div className="flex items-center gap-3 px-4 py-4 md:px-6">
                {open && (
                  <IconButton label={t.common.back} onClick={() => setOpen(null)}>
                    <ArrowLeftIcon size={20} />
                  </IconButton>
                )}
                <PlayDisc label={t.common.playAll} px={48} disabled={!shown.length} onClick={() => playList(shown, 0)}>
                  <PlayIcon size={22} weight="fill" />
                </PlayDisc>
                <IconButton label={t.local.shuffle} size="lg" disabled={!shown.length} onClick={() => playList(shuffled(shown), 0)}>
                  <ShuffleIcon size={22} />
                </IconButton>
                {open && (
                  <div className="min-w-0">
                    <p className="truncate font-semibold">{open.title}</p>
                    <p className="truncate text-sm text-fg-2">{open.sub || t.local.tracksIn(open.tracks.length)}</p>
                  </div>
                )}
              </div>
              <div className="px-2 md:px-3">
                {shown.length ? <TrackList tracks={shown} showAlbum /> : <p className="px-4 text-sm text-fg-2">{t.local.noMatches}</p>}
              </div>
            </>
          )}

          {tab !== "songs" && !open && (
            <ul className="grid grid-cols-2 gap-1 px-2 pt-4 sm:grid-cols-3 md:grid-cols-4 md:gap-2 md:px-4 lg:grid-cols-5 2xl:grid-cols-7">
              {groups.map((g) => (
                <li key={g.key}>
                  <button type="button" onClick={() => setOpen(g)} className="group flex w-full flex-col gap-2 rounded-[16px] p-3 text-left transition-colors hover:bg-surface-2">
                    <Artwork
                      src={g.tracks.find((x) => x.thumb)?.thumb}
                      className={cn("aspect-square w-full shadow-[0_12px_32px_rgb(0_0_0/0.3)]", tab === "artists" ? "rounded-full" : "rounded-[14px]")}
                      iconSize={32}
                    />
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{g.title}</span>
                      <span className="block truncate text-sm text-fg-2">{g.sub ? `${g.sub} · ` : ""}{t.local.tracksIn(g.tracks.length)}</span>
                    </span>
                  </button>
                </li>
              ))}
              {groups.length === 0 && <li className="px-3 text-sm text-fg-2">{t.local.noMatches}</li>}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
