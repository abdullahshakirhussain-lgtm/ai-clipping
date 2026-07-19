"use client";
import { useEffect, useRef, useState } from "react";
import { apiUpload, revalidateAll, useCategories, useVideos, type SourceVideoDto } from "@/lib/api";
import { Button, Card, EmptyState, PageHeader, StatusBadge } from "@/components/ui";
import { timeAgo } from "@/lib/format";

interface UploadSettings {
  style: string;
  position: string;
  reframe: boolean;
  autoEnhance: boolean;
  subtitlesOnly: boolean;
  untouched: boolean;
  commentaryMode: string;
  category: string;
}

const DEFAULTS: UploadSettings = {
  style: "bold-center",
  position: "bottom",
  reframe: false,
  autoEnhance: false,
  subtitlesOnly: false,
  untouched: false,
  commentaryMode: "off",
  category: "",
};

const STORE_KEY = "clipfactory.uploadSettings";

/**
 * Upload settings are baked into a video at ingest and can't be changed after,
 * so silently resetting them to defaults on every page load (which is what plain
 * useState did) meant uploading with the wrong config without ever knowing.
 * They persist now, and the form states plainly that they apply to the next upload.
 */
function useUploadSettings(): [UploadSettings, (patch: Partial<UploadSettings>) => void] {
  const [settings, setSettings] = useState<UploadSettings>(DEFAULTS);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) setSettings({ ...DEFAULTS, ...(JSON.parse(raw) as Partial<UploadSettings>) });
    } catch {
      /* ignore unreadable storage */
    }
  }, []);
  function update(patch: Partial<UploadSettings>) {
    setSettings((cur) => {
      const next = { ...cur, ...patch };
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify(next));
      } catch {
        /* ignore full/blocked storage */
      }
      return next;
    });
  }
  return [settings, update];
}

export default function UploadPage() {
  const { data: videos } = useVideos();
  const { data: cats } = useCategories();
  const categories = (cats ?? []).map((c) => c.name);
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [s, set] = useUploadSettings();
  const { style, position, reframe, autoEnhance, subtitlesOnly, untouched, commentaryMode, category } = s;
  // Per-video, not a remembered setting: context describes THIS upload
  // ("Andrew Tate on the Fresh&Fit podcast"), so it clears after each one.
  const [context, setContext] = useState("");
  // Untouched renders as-is, so framing/SFX genuinely cannot apply — show that
  // rather than letting the toggles look active while being ignored.
  const effectsDisabled = untouched;

  async function upload(file: File) {
    setBusy(true);
    setError(null);
    setProgress(0);
    try {
      const cat = category ? `&category=${encodeURIComponent(category)}` : "";
      const ctx = context.trim() ? `&context=${encodeURIComponent(context.trim().slice(0, 500))}` : "";
      const qs = `?captionStyle=${style}&captionPosition=${position}&reframe=${reframe}&autoEnhance=${autoEnhance}&subtitlesOnly=${subtitlesOnly}&untouched=${untouched}&commentaryMode=${commentaryMode}${cat}${ctx}`;
      await apiUpload<{ sourceVideoId: string }>(`/videos/upload${qs}`, file, setProgress);
      setContext("");
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
        <div className="mb-4 pb-3 border-b" style={{ borderColor: "var(--border)" }}>
          <h2 className="text-sm font-semibold">Settings for your next upload</h2>
          <p className="text-xs mt-0.5" style={{ color: "var(--muted)" }}>
            These are locked in the moment a video uploads and can&apos;t be changed afterwards —
            set them <b>before</b> you drop the file. They&apos;re remembered for next time, and each
            video&apos;s actual settings are shown in the Video Queue.
          </p>
        </div>
        <label
          className="flex items-start gap-2.5 mb-4 p-3 rounded-lg surface-2 border cursor-pointer"
          style={{ borderColor: subtitlesOnly ? "var(--primary)" : "var(--border)" }}
        >
          <input
            type="checkbox"
            checked={subtitlesOnly}
            onChange={(e) => set({ subtitlesOnly: e.target.checked })}
            className="mt-0.5"
          />
          <span>
            <span className="text-sm font-medium">Subtitles only — don&apos;t clip</span>
            <span className="block text-xs" style={{ color: "var(--muted)" }}>
              Skip clip detection and render the whole video as one output. For reposting an already-short video.
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
            onChange={(e) => set({ untouched: e.target.checked })}
            className="mt-0.5"
          />
          <span>
            <span className="text-sm font-medium">Untouched — captions only</span>
            <span className="block text-xs" style={{ color: "var(--muted)" }}>
              Render the video as-is: no jump-cuts, no reframing, no SFX — just burn the subtitles.
              Turning this on <b>disables Smart framing and Smart SFX</b>. Best paired with &ldquo;subtitles only&rdquo; for a faithful repost.
            </span>
          </span>
        </label>
        <div className="flex gap-4 mb-4 flex-wrap">
          <label className="text-sm">
            <span className="block text-xs mb-1" style={{ color: "var(--muted)" }}>Category</span>
            <select
              value={category}
              onChange={(e) => set({ category: e.target.value })}
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
            <span className="block text-xs mb-1" style={{ color: "var(--muted)" }}>Commentary</span>
            <select
              value={commentaryMode}
              onChange={(e) => set({ commentaryMode: e.target.value })}
              className="px-3 py-2 rounded-lg surface-2 border text-sm"
              style={{ borderColor: "var(--border)" }}
              title="AI voice-over: the clip freezes, the line is said, then it resumes"
            >
              <option value="off">Off</option>
              <option value="intro_outro">Intro + outro</option>
              <option value="interject">Interjections</option>
              <option value="full">Full (intro + reacts + outro)</option>
            </select>
          </label>
          <label className="text-sm">
            <span className="block text-xs mb-1" style={{ color: "var(--muted)" }}>Caption style</span>
            <select
              value={style}
              onChange={(e) => set({ style: e.target.value })}
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
              onChange={(e) => set({ position: e.target.value })}
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
              <input type="checkbox" checked={reframe} onChange={(e) => set({ reframe: e.target.checked })} disabled={effectsDisabled} />
              <span className="text-xs" style={{ color: "var(--muted)" }}>Track speaker</span>
            </span>
          </label>
          <label className="text-sm flex flex-col justify-end">
            <span className="block text-xs mb-1" style={{ color: "var(--muted)" }}>Smart SFX (beta)</span>
            <span className="flex items-center gap-2 px-3 py-2 rounded-lg surface-2 border" style={{ borderColor: "var(--border)" }}>
              <input type="checkbox" checked={autoEnhance} onChange={(e) => set({ autoEnhance: e.target.checked })} disabled={effectsDisabled} />
              <span className="text-xs" style={{ color: "var(--muted)" }}>Sparse sound fx</span>
            </span>
          </label>
        </div>
        <label className="block mb-4">
          <span className="block text-xs mb-1" style={{ color: "var(--muted)" }}>
            Context for this video (optional — not remembered, applies to the next upload only)
          </span>
          <textarea
            value={context}
            onChange={(e) => setContext(e.target.value)}
            rows={2}
            maxLength={500}
            placeholder={'Who/what is this? e.g. "Andrew Tate on the Fresh&Fit podcast, defending his ban" — the commentary and titles will use these names.'}
            className="w-full px-3 py-2 rounded-lg surface-2 border outline-none text-sm resize-none"
            style={{ borderColor: context.trim() ? "var(--primary)" : "var(--border)" }}
          />
        </label>
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
              <p className="text-sm mt-1 mb-3" style={{ color: "var(--muted)" }}>
                MP4, MOV, MKV, WebM — up to 8 GB
              </p>
              {/* Spell out exactly what this upload gets rendered with, so the
                  settings above can never silently be the wrong ones. */}
              <div className="text-xs mb-4 flex flex-wrap gap-1.5 justify-center items-center" style={{ color: "var(--muted)" }}>
                <span>Will render with:</span>
                {[
                  subtitlesOnly ? "subtitles only" : "auto-clipped",
                  untouched ? "untouched" : "edited",
                  commentaryMode === "off" ? "no commentary" : `commentary: ${commentaryMode.replace("_", "+")}`,
                  `${style} · ${position}`,
                  ...(reframe && !untouched ? ["smart framing"] : []),
                  ...(autoEnhance && !untouched ? ["smart SFX"] : []),
                  category || "no category",
                ].map((t) => (
                  <span key={t} className="px-1.5 py-0.5 rounded surface-2 border capitalize" style={{ borderColor: "var(--border)" }}>
                    {t}
                  </span>
                ))}
              </div>
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
