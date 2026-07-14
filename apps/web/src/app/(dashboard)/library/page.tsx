"use client";
import { useEffect, useMemo, useState } from "react";
import {
  apiSend,
  clipExportUrl,
  revalidateAll,
  useCalibration,
  useCategories,
  useClipGrid,
  useVideos,
  type ClipDto,
} from "@/lib/api";
import { Button, Card, EmptyState, PageHeader, Spinner } from "@/components/ui";

/** Pull the human-readable "why" tags out of the score breakdown JSON. */
function notesOf(clip: ClipDto): string[] {
  const b = clip.scoreBreakdown as { notes?: unknown } | null;
  return Array.isArray(b?.notes) ? (b!.notes as unknown[]).map(String).slice(0, 4) : [];
}

function triggerDownload(url: string) {
  const a = document.createElement("a");
  a.href = url;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function fmtDuration(sec: number | null): string {
  if (!sec || sec <= 0) return "—";
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return d.toLocaleDateString();
}

const SCORE_FILTERS = [
  { label: "All scores", value: 0 },
  { label: "70+", value: 70 },
  { label: "80+", value: 80 },
  { label: "90+", value: 90 },
];

export default function LibraryPage() {
  const { data: videos } = useVideos();
  const { data: cats } = useCategories();
  const categoryNames = (cats ?? []).map((c) => c.name);
  const [videoId, setVideoId] = useState<string | "all">("all");
  const [view, setView] = useState<"kept" | "discarded">("kept");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  // Client-side filters (no API round-trip — the grid is already loaded).
  const [minScore, setMinScore] = useState(0);
  const [sfxOnly, setSfxOnly] = useState(false);
  const [category, setCategory] = useState<string>("all");

  const { data, isLoading } = useClipGrid({
    kept: view === "kept",
    sourceVideoId: videoId === "all" ? undefined : videoId,
  });

  const allClips = useMemo(() => data?.items ?? [], [data]);
  const categories = useMemo(
    () => [...new Set(allClips.map((c) => c.category).filter(Boolean) as string[])].sort(),
    [allClips],
  );

  const clips = useMemo(
    () =>
      allClips.filter(
        (c) =>
          c.overallScore >= minScore &&
          (!sfxOnly || c.hasSfx) &&
          (category === "all" || c.category === category),
      ),
    [allClips, minScore, sfxOnly, category],
  );

  // Reset selection whenever the scope changes; drop a category filter that no
  // longer exists in the newly-selected video.
  useEffect(() => setSelected(new Set()), [videoId, view]);
  useEffect(() => {
    if (category !== "all" && !categories.includes(category)) setCategory("all");
  }, [categories, category]);

  const selectedIds = [...selected];
  const visibleIds = clips.map((c) => c.id);

  function toggle(id: string) {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAllVisible() {
    setSelected((cur) => {
      const allSelected = visibleIds.length > 0 && visibleIds.every((id) => cur.has(id));
      return allSelected ? new Set() : new Set(visibleIds);
    });
  }

  async function bulk(action: "keep" | "discard") {
    if (selectedIds.length === 0) return;
    setBusy(true);
    try {
      await apiSend("/clips/bulk", "POST", { ids: selectedIds, action });
      setSelected(new Set());
      await revalidateAll();
    } finally {
      setBusy(false);
    }
  }

  async function recategorize(ids: string[], newCategory: string, clearSelection = false) {
    if (ids.length === 0 || !newCategory) return;
    setBusy(true);
    try {
      await apiSend("/clips/category", "POST", { ids, category: newCategory });
      if (clearSelection) setSelected(new Set());
      await revalidateAll();
    } finally {
      setBusy(false);
    }
  }

  // "Export all" respects the current scope: a specific video exports the clips
  // in view; "All videos" exports every kept clip via the no-arg export URL.
  function exportAll() {
    if (videoId === "all") triggerDownload(clipExportUrl());
    else triggerDownload(clipExportUrl(visibleIds));
  }

  const activeVideo = videos?.find((v) => v.id === videoId);

  return (
    <div>
      <PageHeader
        title="Library"
        subtitle="Clips grouped by the video they came from. Pick a video, cull the duds, export the keepers."
        action={
          <div className="flex gap-2">
            {selectedIds.length > 0 && (
              <Button variant="secondary" onClick={() => triggerDownload(clipExportUrl(selectedIds))}>
                Export selected ({selectedIds.length})
              </Button>
            )}
            <Button onClick={exportAll}>
              {videoId === "all" ? "Export all kept" : "Export this video"}
            </Button>
          </div>
        }
      />

      <CalibrationBar />

      <div className="flex gap-6 items-start">
        {/* ── Master rail: source videos ─────────────────────────────── */}
        <aside className="w-72 shrink-0">
          <div className="flex flex-col gap-1">
            <VideoRailItem
              active={videoId === "all"}
              onClick={() => setVideoId("all")}
              title="All videos"
              subtitle={`${videos?.length ?? 0} source video${(videos?.length ?? 0) === 1 ? "" : "s"}`}
            />
            {(videos ?? []).map((v) => (
              <VideoRailItem
                key={v.id}
                active={videoId === v.id}
                onClick={() => setVideoId(v.id)}
                title={v.title ?? "Untitled video"}
                subtitle={`${v.clipCount} clip${v.clipCount === 1 ? "" : "s"} · ${fmtDuration(v.durationSec)} · ${fmtWhen(v.createdAt)}`}
                status={v.status}
              />
            ))}
            {videos && videos.length === 0 && (
              <p className="text-xs px-2 py-3" style={{ color: "var(--muted)" }}>
                No videos yet. Upload one to get started.
              </p>
            )}
          </div>
        </aside>

        {/* ── Detail pane: clips for the selected video ──────────────── */}
        <div className="flex-1 min-w-0">
          {/* Toolbar */}
          <div className="flex items-center gap-3 mb-4 flex-wrap">
            <div className="flex gap-1 p-1 rounded-lg" style={{ background: "var(--surface-2)" }}>
              {(["kept", "discarded"] as const).map((v) => (
                <button
                  key={v}
                  onClick={() => setView(v)}
                  className="px-3 py-1.5 rounded-md text-sm capitalize"
                  style={{
                    background: view === v ? "var(--surface)" : "transparent",
                    color: view === v ? "var(--text)" : "var(--muted)",
                  }}
                >
                  {v}
                </button>
              ))}
            </div>

            <select
              value={minScore}
              onChange={(e) => setMinScore(Number(e.target.value))}
              className="px-2.5 py-1.5 rounded-lg surface-2 border text-sm"
              style={{ borderColor: "var(--border)" }}
            >
              {SCORE_FILTERS.map((f) => (
                <option key={f.value} value={f.value}>{f.label}</option>
              ))}
            </select>

            {categories.length > 0 && (
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="px-2.5 py-1.5 rounded-lg surface-2 border text-sm capitalize"
                style={{ borderColor: "var(--border)" }}
              >
                <option value="all">All categories</option>
                {categories.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            )}

            <button
              onClick={() => setSfxOnly((s) => !s)}
              className="px-2.5 py-1.5 rounded-lg border text-sm"
              style={{
                borderColor: "var(--border)",
                background: sfxOnly ? "var(--primary)" : "var(--surface-2)",
                color: sfxOnly ? "#fff" : "var(--muted)",
              }}
              title="Show only clips with sound effects"
            >
              🔊 SFX
            </button>

            {clips.length > 0 && (
              <button
                onClick={selectAllVisible}
                className="px-2.5 py-1.5 rounded-lg border text-sm surface-2"
                style={{ borderColor: "var(--border)", color: "var(--muted)" }}
              >
                {visibleIds.every((id) => selected.has(id)) ? "Deselect all" : "Select all"}
              </button>
            )}

            {videoId !== "all" && categoryNames.length > 0 && allClips.length > 0 && (
              <select
                value=""
                onChange={(e) => { if (e.target.value) void recategorize(allClips.map((c) => c.id), e.target.value); }}
                className="px-2.5 py-1.5 rounded-lg border text-sm surface-2 capitalize"
                style={{ borderColor: "var(--border)" }}
                title="Set the category for every clip in this video"
                disabled={busy}
              >
                <option value="">Set video category…</option>
                {categoryNames.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            )}

            <span className="text-sm ml-auto" style={{ color: "var(--muted)" }}>
              {activeVideo ? (activeVideo.title ?? "Untitled") + " · " : ""}
              {clips.length} clip{clips.length === 1 ? "" : "s"}
            </span>
          </div>

          {/* Bulk actions bar */}
          {selectedIds.length > 0 && (
            <div className="flex gap-2 mb-4 items-center flex-wrap">
              {view === "kept" ? (
                <Button variant="danger" onClick={() => bulk("discard")} disabled={busy}>
                  Discard ({selectedIds.length})
                </Button>
              ) : (
                <Button variant="secondary" onClick={() => bulk("keep")} disabled={busy}>
                  Restore ({selectedIds.length})
                </Button>
              )}
              {categoryNames.length > 0 && (
                <select
                  value=""
                  onChange={(e) => { if (e.target.value) void recategorize(selectedIds, e.target.value, true); }}
                  className="px-2.5 py-1.5 rounded-lg border text-sm surface-2 capitalize"
                  style={{ borderColor: "var(--border)" }}
                  title="Set the category for the selected clips"
                  disabled={busy}
                >
                  <option value="">Set category ({selectedIds.length})…</option>
                  {categoryNames.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              )}
              <Button variant="ghost" onClick={() => setSelected(new Set())}>Clear</Button>
            </div>
          )}

          {isLoading ? (
            <Spinner />
          ) : clips.length === 0 ? (
            <EmptyState
              title={view === "kept" ? "No clips here" : "Nothing discarded"}
              hint={
                view === "kept"
                  ? allClips.length > 0
                    ? "No clips match the current filters — loosen the score or category filter."
                    : "Upload a video — detected clips land here, best first."
                  : undefined
              }
            />
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {clips.map((clip) => (
                <ClipCard
                  key={clip.id}
                  clip={clip}
                  selected={selected.has(clip.id)}
                  onToggle={() => toggle(clip.id)}
                  categories={categoryNames}
                  onSetCategory={(cat) => recategorize([clip.id], cat)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function VideoRailItem({
  active,
  onClick,
  title,
  subtitle,
  status,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  subtitle: string;
  status?: string;
}) {
  const pending = status && !["READY", "DONE", "COMPLETED"].includes(status);
  return (
    <button
      onClick={onClick}
      className="text-left px-3 py-2.5 rounded-lg transition-colors"
      style={{
        background: active ? "var(--surface)" : "transparent",
        outline: active ? "1px solid var(--primary)" : "1px solid transparent",
      }}
    >
      <div className="text-sm font-medium line-clamp-1">{title}</div>
      <div className="text-xs mt-0.5 flex items-center gap-1.5" style={{ color: "var(--muted)" }}>
        <span className="line-clamp-1">{subtitle}</span>
        {pending && (
          <span className="shrink-0 px-1 rounded text-[10px]" style={{ background: "var(--warning)", color: "#000" }}>
            {status?.toLowerCase()}
          </span>
        )}
      </div>
    </button>
  );
}

function ScoreChip({ label, value }: { label: string; value: number }) {
  const color = value >= 75 ? "var(--success)" : value >= 55 ? "var(--warning)" : "var(--muted)";
  return (
    <div className="flex items-center gap-1.5 text-xs">
      <span style={{ color: "var(--muted)" }}>{label}</span>
      <span className="font-semibold" style={{ color }}>
        {Math.round(value)}
      </span>
    </div>
  );
}

function ClipCard({
  clip,
  selected,
  onToggle,
  categories,
  onSetCategory,
}: {
  clip: ClipDto;
  selected: boolean;
  onToggle: () => void;
  categories: string[];
  onSetCategory: (category: string) => void;
}) {
  const notes = notesOf(clip).slice(0, 2);
  const scoreColor = clip.overallScore >= 75 ? "var(--success)" : clip.overallScore >= 55 ? "var(--warning)" : "var(--muted)";
  return (
    <div
      className="card p-0 overflow-hidden flex flex-col transition-all"
      style={{ outline: selected ? "2px solid var(--primary)" : "1px solid var(--border)" }}
    >
      <div className="relative bg-black" style={{ aspectRatio: "9 / 16" }}>
        {clip.previewUrl ? (
          <video
            src={clip.previewUrl}
            poster={clip.thumbnailUrl ?? undefined}
            controls
            preload="none"
            className="w-full h-full object-contain"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-xs" style={{ color: "var(--muted)" }}>
            {clip.status === "FAILED" ? "render failed" : "rendering…"}
          </div>
        )}
        <label
          className="absolute top-2 left-2 flex items-center justify-center w-6 h-6 rounded-md cursor-pointer"
          style={{ background: selected ? "var(--primary)" : "rgba(0,0,0,0.55)" }}
          title="Select for bulk export"
        >
          <input type="checkbox" checked={selected} onChange={onToggle} className="accent-white" />
        </label>
        <div className="absolute top-2 right-2 flex items-center gap-1">
          {clip.hasSfx && (
            <span className="px-1.5 h-6 flex items-center rounded-md text-xs" style={{ background: "rgba(0,0,0,0.55)", color: "#fff" }} title="Sound effects added">
              🔊
            </span>
          )}
          <span className="px-2 h-6 flex items-center rounded-md text-xs font-bold" style={{ background: "rgba(0,0,0,0.55)", color: scoreColor }}>
            {Math.round(clip.overallScore)}
          </span>
        </div>
      </div>
      <div className="p-3 flex-1 flex flex-col gap-2">
        <div className="text-sm font-medium line-clamp-2 leading-snug" style={{ minHeight: "2.5em" }}>
          {clip.title ?? clip.detectionReason ?? "Untitled clip"}
        </div>
        <div className="flex items-center gap-3 text-xs">
          <ScoreChip label="Hook" value={clip.hookScore} />
          <ScoreChip label="Viral" value={clip.viralScore} />
          <span className="ml-auto" style={{ color: "var(--muted)" }}>{clip.durationSec}s</span>
        </div>
        {notes.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {notes.map((n, i) => (
              <span key={i} className="text-[10px] px-1.5 py-0.5 rounded surface-2" style={{ color: "var(--muted)" }}>{n}</span>
            ))}
          </div>
        )}
        {categories.length > 0 ? (
          <select
            value={clip.category ?? ""}
            onChange={(e) => { if (e.target.value) onSetCategory(e.target.value); }}
            className="text-[11px] px-1.5 py-1 rounded surface-2 border capitalize w-full"
            style={{ borderColor: "var(--border)", color: clip.category ? "var(--text)" : "var(--muted)" }}
            title="Clip category — routes distribution to matching accounts"
          >
            <option value="">— set category —</option>
            {clip.category && !categories.includes(clip.category) && (
              <option value={clip.category}>{clip.category}</option>
            )}
            {categories.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        ) : clip.category ? (
          <span className="text-[10px] px-1.5 py-0.5 rounded capitalize self-start" style={{ background: "var(--primary)", color: "#fff" }}>{clip.category}</span>
        ) : null}
        <div className="mt-auto flex items-center justify-between gap-2 pt-1">
          <button
            onClick={() => triggerDownload(clipExportUrl([clip.id]))}
            className="text-xs px-2.5 py-1.5 rounded-lg surface-2 border font-medium"
            style={{ borderColor: "var(--border)" }}
            title="Export this clip (mp4 + caption)"
          >
            ⬇ Export
          </button>
          <OutcomeRow clipId={clip.id} current={clip.outcome} />
        </div>
      </div>
    </div>
  );
}

const OUTCOMES: Array<{ key: "FLOP" | "OK" | "HIT"; label: string; color: string }> = [
  { key: "FLOP", label: "Flop", color: "var(--danger)" },
  { key: "OK", label: "OK", color: "var(--warning)" },
  { key: "HIT", label: "Hit", color: "var(--success)" },
];

/** Once you've posted a clip, tag how it did — this trains the score model. */
function OutcomeRow({ clipId, current }: { clipId: string; current: ClipDto["outcome"] }) {
  const [busy, setBusy] = useState(false);
  async function set(outcome: "FLOP" | "OK" | "HIT" | null) {
    setBusy(true);
    try {
      await apiSend(`/clips/${clipId}/outcome`, "POST", { outcome });
      await revalidateAll();
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex items-center gap-1" title="How did this clip perform once posted?">
      {OUTCOMES.map((o) => (
        <button
          key={o.key}
          disabled={busy}
          onClick={() => set(current === o.key ? null : o.key)}
          className="text-[10px] px-1.5 py-0.5 rounded border"
          style={{
            background: current === o.key ? o.color : "transparent",
            color: current === o.key ? "#fff" : "var(--muted)",
            borderColor: "var(--border)",
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Shows how many outcomes are labeled + which signals actually predict wins. */
function CalibrationBar() {
  const { data } = useCalibration();
  const [busy, setBusy] = useState(false);
  if (!data) return null;
  const top = data.insights[0];
  async function recompute() {
    setBusy(true);
    try {
      await apiSend("/calibration/recompute", "POST");
      await revalidateAll();
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card className="mb-4 flex items-center justify-between gap-4 flex-wrap py-3">
      <div className="text-sm">
        <span className="font-medium">Score learning</span>
        <span style={{ color: "var(--muted)" }}>
          {" "}
          · {data.sampleSize} labeled clip{data.sampleSize === 1 ? "" : "s"}
          {data.applied ? " · weights calibrated to your results" : " · using default weights"}
          {top && data.sampleSize > 0
            ? ` · best predictor so far: ${top.signal} (${top.correlation >= 0 ? "+" : ""}${top.correlation})`
            : ""}
        </span>
      </div>
      <Button variant="secondary" onClick={recompute} disabled={busy}>
        {busy ? "Recalibrating…" : "Recalibrate"}
      </Button>
    </Card>
  );
}
