"use client";
import { useState } from "react";
import {
  apiSend,
  revalidateAll,
  useCategories,
  useDiscovery,
  type DiscoveredVideoDto,
} from "@/lib/api";
import { Button, Card, EmptyState, PageHeader, Spinner } from "@/components/ui";

const COMMENTARY_OPTIONS = [
  { value: "off", label: "No commentary" },
  { value: "intro_outro", label: "Intro + outro" },
  { value: "interject", label: "Interjections" },
  { value: "full", label: "Full" },
];

export default function FinderPage() {
  const { data, isLoading } = useDiscovery();
  const [polling, setPolling] = useState(false);
  const [pollMsg, setPollMsg] = useState<string | null>(null);

  async function refresh() {
    setPolling(true);
    setPollMsg(null);
    try {
      const r = await apiSend<{ upserted: number }>("/discovery/poll", "POST");
      setPollMsg(`Pulled ${r.upserted} candidate${r.upserted === 1 ? "" : "s"}`);
      await revalidateAll();
    } catch (e) {
      setPollMsg(e instanceof Error ? e.message : "Refresh failed");
    } finally {
      setPolling(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Finder"
        subtitle="Videos accelerating on their source platform right now — review and send the best straight into your pipeline."
      />
      <div className="flex items-center gap-3 mb-4">
        <Button onClick={refresh} disabled={polling}>
          {polling ? "Refreshing…" : "↻ Refresh now"}
        </Button>
        {pollMsg && <span className="text-xs" style={{ color: "var(--muted)" }}>{pollMsg}</span>}
      </div>

      {isLoading ? (
        <Spinner />
      ) : !data || data.length === 0 ? (
        <EmptyState
          title="Nothing discovered yet"
          hint="Set DISCOVERY_ENABLED + Reddit credentials on the API, or hit Refresh now. The feed ranks by how fast each post is climbing."
        />
      ) : (
        <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))" }}>
          {data.map((v) => (
            <FinderCard key={v.id} v={v} />
          ))}
        </div>
      )}
    </div>
  );
}

function FinderCard({ v }: { v: DiscoveredVideoDto }) {
  const { data: cats } = useCategories();
  const categories = (cats ?? []).map((c) => c.name);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  // Repost-friendly defaults — Finder content is usually already the highlight.
  const [category, setCategory] = useState("");
  const [commentaryMode, setCommentaryMode] = useState("interject");
  const [subtitlesOnly, setSubtitlesOnly] = useState(true);
  const [untouched, setUntouched] = useState(true);

  async function ingest() {
    setBusy(true);
    setMsg(null);
    try {
      await apiSend(`/discovery/${v.id}/ingest`, "POST", {
        category: category || undefined,
        commentaryMode,
        subtitlesOnly,
        untouched,
      });
      setMsg("Sent to pipeline →");
      await revalidateAll();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Failed");
      setBusy(false);
    }
  }

  async function hide() {
    setBusy(true);
    try {
      await apiSend(`/discovery/${v.id}/hide`, "POST");
      await revalidateAll();
    } finally {
      setBusy(false);
    }
  }

  const age = v.ageHours < 1 ? `${Math.round(v.ageHours * 60)}m` : `${v.ageHours.toFixed(1)}h`;

  return (
    <Card className="p-0 overflow-hidden flex flex-col">
      <div className="relative bg-black" style={{ aspectRatio: "16 / 9" }}>
        {v.thumbnailUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={v.thumbnailUrl} alt="" className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-xs" style={{ color: "var(--muted)" }}>
            {v.mediaType}
          </div>
        )}
        <span
          className="absolute top-2 right-2 px-2 h-6 flex items-center rounded-md text-xs font-bold"
          style={{ background: "rgba(0,0,0,0.6)", color: "var(--success)" }}
          title="Velocity — how fast it's climbing (upvotes/hour, decayed by age)"
        >
          ⚡{v.velocity}
        </span>
      </div>
      <div className="p-3 flex-1 flex flex-col gap-2">
        <div className="text-sm font-medium line-clamp-2 leading-snug" style={{ minHeight: "2.5em" }}>
          <a href={v.permalink} target="_blank" rel="noopener noreferrer" style={{ color: "var(--text)" }}>
            {v.title}
          </a>
        </div>
        <div className="flex items-center gap-2 text-xs flex-wrap" style={{ color: "var(--muted)" }}>
          <span className="px-1.5 py-0.5 rounded surface-2 capitalize">r/{v.source}</span>
          <span>↑{v.score.toLocaleString()}</span>
          <span>💬{v.comments.toLocaleString()}</span>
          <span className="ml-auto">{age} old</span>
        </div>

        <div className="mt-auto flex items-center gap-2 pt-1">
          <button
            onClick={() => setOpen((o) => !o)}
            className="text-xs px-2.5 py-1.5 rounded-lg border font-medium flex-1"
            style={{ borderColor: "var(--primary)", color: "var(--primary)" }}
          >
            → Clip this
          </button>
          <button
            onClick={hide}
            disabled={busy}
            className="text-xs px-2.5 py-1.5 rounded-lg surface-2 border"
            style={{ borderColor: "var(--border)", color: "var(--muted)" }}
            title="Hide from the feed"
          >
            Hide
          </button>
        </div>

        {open && (
          <div className="pt-2.5 mt-1 border-t flex flex-col gap-2" style={{ borderColor: "var(--border)" }}>
            <label className="block">
              <span className="text-[10px] block mb-1" style={{ color: "var(--muted)" }}>Category</span>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="text-[11px] px-1.5 py-1 rounded surface-2 border capitalize w-full"
                style={{ borderColor: "var(--border)" }}
              >
                <option value="">— none —</option>
                {categories.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="text-[10px] block mb-1" style={{ color: "var(--muted)" }}>Commentary</span>
              <select
                value={commentaryMode}
                onChange={(e) => setCommentaryMode(e.target.value)}
                className="text-[11px] px-1.5 py-1 rounded surface-2 border w-full"
                style={{ borderColor: "var(--border)" }}
              >
                {COMMENTARY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
            <label className="flex items-center gap-2 text-[11px]" style={{ color: "var(--muted)" }}>
              <input type="checkbox" checked={subtitlesOnly} onChange={(e) => setSubtitlesOnly(e.target.checked)} />
              Subtitles only (repost the whole clip, no re-cutting)
            </label>
            <label className="flex items-center gap-2 text-[11px]" style={{ color: "var(--muted)" }}>
              <input type="checkbox" checked={untouched} onChange={(e) => setUntouched(e.target.checked)} />
              Untouched (captions only, no jump-cuts/SFX)
            </label>
            <div className="flex items-center gap-2">
              <button
                onClick={ingest}
                disabled={busy}
                className="text-[11px] px-2.5 py-1.5 rounded-lg border font-medium"
                style={{ borderColor: "var(--primary)", color: "var(--primary)" }}
              >
                {busy ? "Sending…" : "Send to pipeline"}
              </button>
              {msg && <span className="text-[10px]" style={{ color: "var(--muted)" }}>{msg}</span>}
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
