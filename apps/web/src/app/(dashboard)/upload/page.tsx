"use client";
import { useRef, useState } from "react";
import { apiUpload, revalidateAll, useCategories, useVideos, type SourceVideoDto } from "@/lib/api";
import { Button, Card, EmptyState, PageHeader, StatusBadge } from "@/components/ui";
import { timeAgo } from "@/lib/format";

export default function UploadPage() {
  const { data: videos } = useVideos();
  const { data: cats } = useCategories();
  const categories = (cats ?? []).map((c) => c.name);
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [style, setStyle] = useState("bold-center");
  const [position, setPosition] = useState("bottom");
  const [reframe, setReframe] = useState(false);
  const [autoEnhance, setAutoEnhance] = useState(false);
  const [subtitlesOnly, setSubtitlesOnly] = useState(false);
  const [untouched, setUntouched] = useState(false);
  const [category, setCategory] = useState("");

  async function upload(file: File) {
    setBusy(true);
    setError(null);
    setProgress(0);
    try {
      const cat = category ? `&category=${encodeURIComponent(category)}` : "";
      const qs = `?captionStyle=${style}&captionPosition=${position}&reframe=${reframe}&autoEnhance=${autoEnhance}&subtitlesOnly=${subtitlesOnly}&untouched=${untouched}${cat}`;
      await apiUpload<{ sourceVideoId: string }>(`/videos/upload${qs}`, file, setProgress);
      await revalidateAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setBusy(false);
      setProgress(0);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <div>
      <PageHeader
        title="Upload"
        subtitle="Drop your own source video. It transcribes, detects clips, scores them, and renders 9:16 automatically."
      />

      <Card className="mb-6">
        <label
          className="flex items-start gap-2.5 mb-4 p-3 rounded-lg surface-2 border cursor-pointer"
          style={{ borderColor: subtitlesOnly ? "var(--primary)" : "var(--border)" }}
        >
          <input
            type="checkbox"
            checked={subtitlesOnly}
            onChange={(e) => setSubtitlesOnly(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            <span className="text-sm font-medium">Subtitles only — don&apos;t clip</span>
            <span className="block text-xs" style={{ color: "var(--muted)" }}>
              Skip clip detection and render the whole video as one output (captions, framing &amp; SFX still apply). For reposting an already-short video.
            </span>
          </span>
        </label>
        <label
          className="flex items-start gap-2.5 mb-4 p-3 rounded-lg surface-2 border cursor-pointer"
          style={{ borderColor: untouched ? "var(--primary)" : "var(--border)" }}
        >
          <input
            type="checkbox"
            checked={untouched}
            onChange={(e) => setUntouched(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            <span className="text-sm font-medium">Untouched — captions only</span>
            <span className="block text-xs" style={{ color: "var(--muted)" }}>
              Render the video as-is: no jump-cuts, no reframing, no SFX — just burn the subtitles. Best paired with &ldquo;subtitles only&rdquo; for a faithful repost.
            </span>
          </span>
        </label>
        <div className="flex gap-4 mb-4 flex-wrap">
          <label className="text-sm">
            <span className="block text-xs mb-1" style={{ color: "var(--muted)" }}>Category</span>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="px-3 py-2 rounded-lg surface-2 border text-sm"
              style={{ borderColor: "var(--border)" }}
            >
              <option value="">— none —</option>
              {categories.map((c) => (
                <option key={c} value={c} className="capitalize">{c}</option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="block text-xs mb-1" style={{ color: "var(--muted)" }}>Caption style</span>
            <select
              value={style}
              onChange={(e) => setStyle(e.target.value)}
              className="px-3 py-2 rounded-lg surface-2 border text-sm"
              style={{ borderColor: "var(--border)" }}
            >
              <option value="bold-center">Bold white</option>
              <option value="yellow-pop">Yellow pop</option>
              <option value="clean-bottom">Clean / subtle</option>
            </select>
          </label>
          <label className="text-sm">
            <span className="block text-xs mb-1" style={{ color: "var(--muted)" }}>Position</span>
            <select
              value={position}
              onChange={(e) => setPosition(e.target.value)}
              className="px-3 py-2 rounded-lg surface-2 border text-sm"
              style={{ borderColor: "var(--border)" }}
            >
              <option value="bottom">Bottom</option>
              <option value="middle">Middle</option>
              <option value="top">Top</option>
            </select>
          </label>
          <label className="text-sm flex flex-col justify-end">
            <span className="block text-xs mb-1" style={{ color: "var(--muted)" }}>Smart framing (beta)</span>
            <span className="flex items-center gap-2 px-3 py-2 rounded-lg surface-2 border" style={{ borderColor: "var(--border)" }}>
              <input type="checkbox" checked={reframe} onChange={(e) => setReframe(e.target.checked)} />
              <span className="text-xs" style={{ color: "var(--muted)" }}>Track speaker</span>
            </span>
          </label>
          <label className="text-sm flex flex-col justify-end">
            <span className="block text-xs mb-1" style={{ color: "var(--muted)" }}>Smart SFX (beta)</span>
            <span className="flex items-center gap-2 px-3 py-2 rounded-lg surface-2 border" style={{ borderColor: "var(--border)" }}>
              <input type="checkbox" checked={autoEnhance} onChange={(e) => setAutoEnhance(e.target.checked)} />
              <span className="text-xs" style={{ color: "var(--muted)" }}>Sparse sound fx</span>
            </span>
          </label>
        </div>
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const file = e.dataTransfer.files?.[0];
            if (file) void upload(file);
          }}
          className="rounded-xl border-2 border-dashed p-10 text-center transition-colors"
          style={{
            borderColor: dragging ? "var(--primary)" : "var(--border)",
            background: dragging ? "var(--surface-2)" : "transparent",
          }}
        >
          {busy ? (
            <div>
              <p className="text-sm mb-3" style={{ color: "var(--muted)" }}>
                Uploading… {Math.round(progress * 100)}%
              </p>
              <div className="h-2 rounded-full overflow-hidden" style={{ background: "var(--surface-2)" }}>
                <div
                  className="h-full transition-all"
                  style={{ width: `${Math.round(progress * 100)}%`, background: "var(--primary)" }}
                />
              </div>
            </div>
          ) : (
            <>
              <p className="font-medium">Drag & drop a video here</p>
              <p className="text-sm mt-1 mb-4" style={{ color: "var(--muted)" }}>
                MP4, MOV, MKV, WebM — up to 8 GB
              </p>
              <Button onClick={() => inputRef.current?.click()}>Choose file</Button>
            </>
          )}
          <input
            ref={inputRef}
            type="file"
            accept="video/*"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void upload(file);
            }}
          />
        </div>
        {error && (
          <p className="text-sm mt-3" style={{ color: "var(--danger)" }}>
            {error}
          </p>
        )}
      </Card>

      <h2 className="text-sm font-semibold mb-3" style={{ color: "var(--muted)" }}>
        Recent uploads
      </h2>
      {!videos || videos.length === 0 ? (
        <EmptyState title="Nothing uploaded yet" hint="Your uploaded videos and their processing status appear here." />
      ) : (
        <div className="space-y-2">
          {videos.map((v) => (
            <VideoRow key={v.id} video={v} />
          ))}
        </div>
      )}
    </div>
  );
}

function VideoRow({ video }: { video: SourceVideoDto }) {
  return (
    <div className="card p-4 flex items-center justify-between gap-4">
      <div className="min-w-0">
        <div className="font-medium truncate">{video.title ?? video.originalUrl ?? "Untitled"}</div>
        <div className="text-xs" style={{ color: "var(--muted)" }}>
          {video.clipCount} clip{video.clipCount === 1 ? "" : "s"} · {timeAgo(video.createdAt)}
          {video.error ? ` · ${video.error}` : ""}
        </div>
      </div>
      <StatusBadge status={video.status} />
    </div>
  );
}
