"use client";
import { useState } from "react";
import { apiGet, apiSend, apiUpload, revalidateAll, runPlan } from "@/lib/api";
import { Button } from "@/components/ui";

type ManualPlan = {
  sourceVideoId: string;
  format: string;
  title: string;
  aspect: string;
  clips: { prompt: string; seconds: number }[];
  characterRefUrl: string | null;
  uploaded: (string | null)[];
};

/**
 * Manual clip workflow (Video + Cooking): the pipeline plans the script + per-clip
 * prompts (+ voiceover/character for Video); you generate each clip on a free
 * platform and upload them one-by-one — copy prompt → upload → Next — then Assemble.
 */
export function ManualClips({ format, categories }: { format: "video" | "cook"; categories: string[] }) {
  const [topic, setTopic] = useState("");
  const [direction, setDirection] = useState("");
  const [length, setLength] = useState<"short" | "long">("short");
  const [category, setCategory] = useState("");
  const [niche, setNiche] = useState("");
  const [topics, setTopics] = useState<string[]>([]);
  const [suggesting, setSuggesting] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [planSec, setPlanSec] = useState(0);
  const [plan, setPlan] = useState<ManualPlan | null>(null);
  const [step, setStep] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const isVideo = format === "video";

  async function doPlan() {
    if (topic.trim().length < 3) return;
    setPlanning(true);
    setPlanSec(0);
    setMsg(null);
    try {
      const p = await runPlan<ManualPlan>(
        "/manual",
        {
          format,
          topic: topic.trim(),
          direction: isVideo ? direction.trim() || undefined : undefined,
          length,
          category: category || undefined,
        },
        { onTick: setPlanSec },
      );
      setPlan(p);
      setStep(0);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Couldn't plan");
    } finally {
      setPlanning(false);
    }
  }

  // Reuse the Slideshow topic suggester (Video only — cook ideas differ). A typed
  // niche wins over the category dropdown for tailored ideas.
  async function suggest() {
    setSuggesting(true);
    setMsg(null);
    try {
      const seed = niche.trim() || category;
      const r = await apiGet<{ topics: string[] }>(
        `/story/topics${seed ? `?category=${encodeURIComponent(seed)}` : ""}`,
      );
      setTopics(r.topics);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Couldn't get ideas");
    } finally {
      setSuggesting(false);
    }
  }

  async function uploadClip(file: File) {
    if (!plan) return;
    setUploading(true);
    setMsg(null);
    try {
      const r = await apiUpload<{ uploaded: (string | null)[]; total: number; complete: boolean }>(
        `/manual/${plan.sourceVideoId}/clip/${step}`,
        file,
      );
      setPlan({ ...plan, uploaded: r.uploaded });
      // Advance to the next not-yet-uploaded clip, if any.
      const next = r.uploaded.findIndex((u, i) => i > step && !u);
      if (next !== -1) setStep(next);
      else if (step < plan.clips.length - 1) setStep(step + 1);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  async function assemble() {
    if (!plan) return;
    setBusy(true);
    setMsg(null);
    try {
      await apiSend(`/manual/${plan.sourceVideoId}/assemble`, "POST", {});
      setMsg("Assembling — it'll appear in the Library when done. Track it in the Video Queue.");
      await revalidateAll();
      setPlan(null);
      setTopic("");
      setStep(0);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Couldn't assemble");
    } finally {
      setBusy(false);
    }
  }

  async function copyPrompt() {
    if (!plan) return;
    try {
      await navigator.clipboard.writeText(plan.clips[step]!.prompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard blocked */
    }
  }

  const allUploaded = plan ? plan.uploaded.length > 0 && plan.uploaded.every(Boolean) : false;
  const uploadedCount = plan ? plan.uploaded.filter(Boolean).length : 0;

  return (
    <>
      {!plan && (
        <>
          <label className="block mb-3">
            <span className="block text-xs mb-1" style={{ color: "var(--muted)" }}>{format === "cook" ? "Dish" : "Topic"}</span>
            <textarea
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              rows={2}
              maxLength={300}
              placeholder={format === "cook" ? "e.g. trout grilled on a river stone" : "e.g. a discipline pep-talk for someone stuck on Wednesday"}
              className="w-full px-3 py-2 rounded-lg surface-2 border outline-none text-sm resize-none"
              style={{ borderColor: topic.trim() ? "var(--primary)" : "var(--border)" }}
            />
          </label>

          {isVideo && (
            <>
              <label className="block mb-3">
                <span className="block text-xs mb-1" style={{ color: "var(--muted)" }}>Description (optional)</span>
                <textarea
                  value={direction}
                  onChange={(e) => setDirection(e.target.value)}
                  rows={8}
                  maxLength={12000}
                  placeholder="the path to take — what to write, the angle/tone, what to mention or avoid (e.g. 'a calm second-person pep-talk, concrete and practical, no clichés, end on one clear action'). Write as much as you like — a full brief is fine."
                  className="w-full px-3 py-2 rounded-lg surface-2 border outline-none text-sm resize-none"
                  style={{ borderColor: "var(--border)" }}
                />
              </label>

              <div className="flex items-center gap-2 mb-3">
                <input
                  value={niche}
                  onChange={(e) => setNiche(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void suggest(); } }}
                  placeholder="niche for ideas — e.g. discipline, stoicism, focus, morning routines"
                  className="flex-1 px-3 py-2 rounded-lg surface-2 border outline-none text-sm"
                  style={{ borderColor: "var(--border)" }}
                />
                <Button onClick={suggest} disabled={suggesting} variant="secondary">
                  {suggesting ? "Thinking…" : "💡 Suggest"}
                </Button>
              </div>
              {topics.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mb-3">
                  {topics.map((t) => (
                    <button
                      key={t}
                      onClick={() => setTopic(t)}
                      className="text-[11px] px-2 py-1 rounded-lg surface-2 border text-left"
                      style={{ borderColor: "var(--border)" }}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}

          <div className="flex items-center gap-2 mb-3 flex-wrap">
            <div className="flex gap-1 p-1 rounded-lg" style={{ background: "var(--surface-2)" }}>
              {(["short", "long"] as const).map((l) => (
                <button
                  key={l}
                  onClick={() => setLength(l)}
                  className="px-3 py-1.5 rounded-md text-sm capitalize"
                  style={{ background: length === l ? "var(--surface)" : "transparent", color: length === l ? "var(--text)" : "var(--muted)" }}
                >
                  {l === "short" ? "Short" : "Long form"}
                </button>
              ))}
            </div>
            {categories.length > 0 && (
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="text-sm px-2 py-2 rounded-lg surface-2 border capitalize"
                style={{ borderColor: "var(--border)" }}
              >
                <option value="">— category —</option>
                {categories.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            )}
          </div>
          <div className="flex items-center gap-2 mb-4 flex-wrap">
            <Button onClick={doPlan} disabled={planning || topic.trim().length < 3}>
              {planning ? `Planning… ${planSec}s` : "🎬 Plan the clips"}
            </Button>
            <span className="text-[11px]" style={{ color: "var(--muted)" }}>
              Free — writes the script{format === "video" ? " + voiceover" : ""} and the per-clip prompts. You generate each clip on a free platform and upload it. No video generation is billed here.
            </span>
          </div>
        </>
      )}

      {plan && (
        <>
          {plan.characterRefUrl && (
            <div className="mb-4 flex items-start gap-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={plan.characterRefUrl} alt="character reference" className="rounded-lg border w-[120px]" style={{ borderColor: "var(--border)" }} />
              <div className="text-[11px]" style={{ color: "var(--muted)" }}>
                <a href={plan.characterRefUrl} target="_blank" rel="noreferrer" className="underline">Open / save this character reference</a> and upload it to your gen platform (Flow/Higgsfield) so the same character carries across every clip.
              </div>
            </div>
          )}

          <div className="mb-2 text-sm font-medium">
            Clip {step + 1} of {plan.clips.length}
            <span className="ml-2 text-[11px]" style={{ color: "var(--muted)" }}>· {uploadedCount}/{plan.clips.length} uploaded</span>
          </div>

          {/* Clip navigator dots */}
          <div className="flex flex-wrap gap-1 mb-3">
            {plan.clips.map((_, i) => (
              <button
                key={i}
                onClick={() => setStep(i)}
                className="w-7 h-7 rounded-md text-[11px] border"
                style={{
                  borderColor: i === step ? "var(--primary)" : "var(--border)",
                  background: plan.uploaded[i] ? "var(--success)" : "var(--surface-2)",
                  color: plan.uploaded[i] ? "#fff" : "var(--muted)",
                }}
                title={plan.uploaded[i] ? "uploaded" : "not uploaded"}
              >
                {i + 1}
              </button>
            ))}
          </div>

          <div className="mb-2">
            <span className="block text-xs mb-1" style={{ color: "var(--muted)" }}>Video prompt — copy this into your gen platform</span>
            <textarea
              readOnly
              value={plan.clips[step]!.prompt}
              rows={6}
              className="w-full px-2.5 py-2 rounded-lg surface-2 border outline-none text-[12px] leading-snug resize-y"
              style={{ borderColor: "var(--border)" }}
            />
          </div>
          <div className="flex items-center gap-2 mb-4 flex-wrap">
            <Button variant="secondary" onClick={copyPrompt}>{copied ? "✓ Copied" : "⧉ Copy prompt"}</Button>
            <label className="text-xs px-3 py-2 rounded-lg surface-2 border font-medium cursor-pointer" style={{ borderColor: plan.uploaded[step] ? "var(--success)" : "var(--primary)" }}>
              {uploading ? "Uploading…" : plan.uploaded[step] ? "↻ Replace clip" : "⬆ Upload clip"}
              <input
                type="file"
                accept="video/*"
                className="hidden"
                disabled={uploading}
                onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadClip(f); e.target.value = ""; }}
              />
            </label>
            {step < plan.clips.length - 1 && (
              <Button variant="ghost" onClick={() => setStep(step + 1)}>Next →</Button>
            )}
          </div>

          <div className="flex items-center gap-3 pt-2 border-t" style={{ borderColor: "var(--border)" }}>
            <Button onClick={assemble} disabled={busy || !allUploaded}>
              {busy ? "Starting…" : allUploaded ? "🎬 Assemble the video" : `Upload all ${plan.clips.length} clips to assemble`}
            </Button>
            <Button variant="ghost" onClick={() => { setPlan(null); setStep(0); }}>Start over</Button>
          </div>
        </>
      )}

      {msg && <p className="text-xs mt-3" style={{ color: "var(--muted)" }}>{msg}</p>}
    </>
  );
}
