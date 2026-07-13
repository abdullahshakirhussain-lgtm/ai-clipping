"use client";
import { useMemo, useState } from "react";
import {
  apiSend,
  clipExportUrl,
  revalidateAll,
  useCalibration,
  useClipGrid,
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

export default function LibraryPage() {
  const [view, setView] = useState<"kept" | "discarded">("kept");
  const { data, isLoading } = useClipGrid({ kept: view === "kept" });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const clips = useMemo(() => data?.items ?? [], [data]);
  const selectedIds = [...selected];

  function toggle(id: string) {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
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

  return (
    <div>
      <PageHeader
        title="Library"
        subtitle="Every detected clip, ranked by score. Cull the duds, export the keepers."
        action={
          <div className="flex gap-2">
            {selectedIds.length > 0 && (
              <Button variant="secondary" onClick={() => triggerDownload(clipExportUrl(selectedIds))}>
                Export selected ({selectedIds.length})
              </Button>
            )}
            <Button onClick={() => triggerDownload(clipExportUrl())}>Export all kept</Button>
          </div>
        }
      />

      <CalibrationBar />

      <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
        <div className="flex gap-1 p-1 rounded-lg" style={{ background: "var(--surface-2)" }}>
          {(["kept", "discarded"] as const).map((v) => (
            <button
              key={v}
              onClick={() => {
                setView(v);
                setSelected(new Set());
              }}
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
        {selectedIds.length > 0 && (
          <div className="flex gap-2">
            {view === "kept" ? (
              <Button variant="danger" onClick={() => bulk("discard")} disabled={busy}>
                Discard ({selectedIds.length})
              </Button>
            ) : (
              <Button variant="secondary" onClick={() => bulk("keep")} disabled={busy}>
                Restore ({selectedIds.length})
              </Button>
            )}
            <Button variant="ghost" onClick={() => setSelected(new Set())}>
              Clear
            </Button>
          </div>
        )}
      </div>

      {isLoading ? (
        <Spinner />
      ) : clips.length === 0 ? (
        <EmptyState
          title={view === "kept" ? "No clips yet" : "Nothing discarded"}
          hint={view === "kept" ? "Upload a video — detected clips land here, best first." : undefined}
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {clips.map((clip) => (
            <ClipCard
              key={clip.id}
              clip={clip}
              selected={selected.has(clip.id)}
              onToggle={() => toggle(clip.id)}
            />
          ))}
        </div>
      )}
    </div>
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
}: {
  clip: ClipDto;
  selected: boolean;
  onToggle: () => void;
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
            {clip.category && (
              <span className="text-[10px] px-1.5 py-0.5 rounded capitalize" style={{ background: "var(--primary)", color: "#fff" }}>{clip.category}</span>
            )}
          </div>
        )}
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
