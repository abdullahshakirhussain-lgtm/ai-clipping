"use client";
import { useState } from "react";
import { apiGet, apiSend, revalidateAll, useCategories } from "@/lib/api";
import { Button, Card, PageHeader } from "@/components/ui";

const STYLES = [
  { value: "stick-scene", label: "Stick figures + colorful scenes" },
  { value: "doodle", label: "Doodle (stick figures)" },
  { value: "whiteboard", label: "Whiteboard" },
  { value: "flat-vector", label: "Flat vector" },
  { value: "notebook-sketch", label: "Notebook sketch" },
];
const NARRATORS = [
  { value: "storyteller", label: "Storyteller (warm, suspenseful)" },
  { value: "hyped", label: "Hyped (high-energy)" },
  { value: "deadpan-documentary", label: "Deadpan documentary" },
  { value: "conspiratorial", label: "Conspiratorial (hushed)" },
];
const CAPTION_STYLES = [
  { value: "bold-center", label: "Bold center" },
  { value: "yellow-pop", label: "Yellow pop" },
  { value: "clean-bottom", label: "Clean" },
];
const CAPTION_POSITIONS = [
  { value: "top", label: "Top" },
  { value: "middle", label: "Middle" },
  { value: "bottom", label: "Bottom" },
];
const MUSIC = [
  { value: "none", label: "No music" },
  { value: "calm", label: "Calm" },
  { value: "tense", label: "Tense" },
  { value: "upbeat", label: "Upbeat" },
  { value: "epic", label: "Epic" },
];

export default function CreatePage() {
  const { data: cats } = useCategories();
  const categories = (cats ?? []).map((c) => c.name);

  const [format, setFormat] = useState<"story" | "cook">("story");
  const [dish, setDish] = useState("");
  const [cookShots, setCookShots] = useState<{ prompt: string }[]>([]);
  const [cookTitle, setCookTitle] = useState("");
  const [cookDescription, setCookDescription] = useState("");
  const [cookHashtags, setCookHashtags] = useState<string[]>([]);
  const [planning, setPlanning] = useState(false);
  const [topic, setTopic] = useState("");
  const [style, setStyle] = useState("stick-scene");
  const [narrator, setNarrator] = useState("storyteller");
  const [voiceTier, setVoiceTier] = useState<"standard" | "premium">("standard");
  const [category, setCategory] = useState("");
  const [captionStyle, setCaptionStyle] = useState("bold-center");
  const [captionPosition, setCaptionPosition] = useState("middle");
  const [music, setMusic] = useState("none");

  const [niche, setNiche] = useState("");
  const [topics, setTopics] = useState<string[]>([]);
  const [suggesting, setSuggesting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function suggest() {
    setSuggesting(true);
    setMsg(null);
    try {
      // A typed niche wins over the category dropdown for tailored ideas.
      const seed = niche.trim() || category;
      const r = await apiGet<{ topics: string[] }>(
        `/story/topics${seed ? `?category=${encodeURIComponent(seed)}` : ""}`,
      );
      setTopics(r.topics);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Couldn't fetch topics");
    } finally {
      setSuggesting(false);
    }
  }

  const canGenerate = format === "story" ? topic.trim().length >= 3 : cookShots.length > 0;

  async function planShots() {
    if (dish.trim().length < 3) return;
    setPlanning(true);
    setMsg(null);
    try {
      const plan = await apiSend<{ title: string; description: string; hashtags: string[]; shots: { prompt: string }[] }>(
        "/cook/plan",
        "POST",
        { dish: dish.trim() },
      );
      setCookShots(plan.shots);
      setCookTitle(plan.title);
      setCookDescription(plan.description);
      setCookHashtags(plan.hashtags);
      if (plan.shots.length === 0) setMsg("The planner returned no shots — try a more specific dish.");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Couldn't plan the shots");
    } finally {
      setPlanning(false);
    }
  }

  async function generate() {
    if (!canGenerate) return;
    setBusy(true);
    setMsg(null);
    try {
      if (format === "cook") {
        await apiSend("/cook", "POST", {
          dish: dish.trim(),
          title: cookTitle || undefined,
          description: cookDescription || undefined,
          hashtags: cookHashtags,
          shots: cookShots.map((s) => ({ prompt: s.prompt })),
          category: category || undefined,
        });
        setDish("");
        setCookShots([]);
        setCookTitle("");
        setCookDescription("");
      } else {
        await apiSend("/story", "POST", {
          topic: topic.trim(),
          style,
          narrator,
          voiceTier,
          category: category || undefined,
          captionStyle,
          captionPosition,
          music,
        });
        setTopic("");
      }
      setMsg("Generating… it'll appear in the Library when done. Track progress in the Video Queue.");
      await revalidateAll();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Failed to start");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Create"
        subtitle="Generate an original video — a narrated story slideshow or a cook-in-the-wild clip. 100% your content, no copyright risk."
      />

      <Card className="mb-6 max-w-2xl">
        <div className="flex gap-1 mb-5 p-1 rounded-lg surface-2 border w-fit" style={{ borderColor: "var(--border)" }}>
          {(["story", "cook"] as const).map((f) => (
            <button
              key={f}
              onClick={() => { setFormat(f); setMsg(null); }}
              className="text-sm px-3 py-1.5 rounded-md font-medium transition-colors"
              style={f === format ? { background: "var(--primary)", color: "#fff" } : { color: "var(--muted)" }}
            >
              {f === "story" ? "📖 Story slideshow" : "🍳 Cook clip"}
            </button>
          ))}
        </div>

        {format === "story" && (
        <>
        <label className="block mb-4">
          <span className="block text-xs mb-1" style={{ color: "var(--muted)" }}>Topic</span>
          <textarea
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            rows={2}
            maxLength={300}
            placeholder="e.g. the con man who sold the Eiffel Tower twice"
            className="w-full px-3 py-2 rounded-lg surface-2 border outline-none text-sm resize-none"
            style={{ borderColor: topic.trim() ? "var(--primary)" : "var(--border)" }}
          />
        </label>

        <div className="flex items-center gap-2 mb-4">
          <input
            value={niche}
            onChange={(e) => setNiche(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void suggest(); } }}
            placeholder="niche for ideas — e.g. cursed history, space, sports scandals"
            className="flex-1 px-3 py-2 rounded-lg surface-2 border outline-none text-sm"
            style={{ borderColor: "var(--border)" }}
          />
          <Button onClick={suggest} disabled={suggesting} variant="secondary">
            {suggesting ? "Thinking…" : "💡 Suggest"}
          </Button>
        </div>
        {topics.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-4">
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

        <div className="grid grid-cols-2 gap-4 mb-4">
          <label className="block">
            <span className="block text-xs mb-1" style={{ color: "var(--muted)" }}>Art style</span>
            <select value={style} onChange={(e) => setStyle(e.target.value)}
              className="text-sm px-2 py-2 rounded-lg surface-2 border w-full" style={{ borderColor: "var(--border)" }}>
              {STYLES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="block text-xs mb-1" style={{ color: "var(--muted)" }}>Narrator</span>
            <select value={narrator} onChange={(e) => setNarrator(e.target.value)}
              className="text-sm px-2 py-2 rounded-lg surface-2 border w-full" style={{ borderColor: "var(--border)" }}>
              {NARRATORS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="block text-xs mb-1" style={{ color: "var(--muted)" }}>Voice</span>
            <select value={voiceTier} onChange={(e) => setVoiceTier(e.target.value as "standard" | "premium")}
              className="text-sm px-2 py-2 rounded-lg surface-2 border w-full" style={{ borderColor: "var(--border)" }}>
              <option value="standard">Standard (OpenAI)</option>
              <option value="premium">Premium (ElevenLabs)</option>
            </select>
          </label>
          <label className="block">
            <span className="block text-xs mb-1" style={{ color: "var(--muted)" }}>Music</span>
            <select value={music} onChange={(e) => setMusic(e.target.value)}
              className="text-sm px-2 py-2 rounded-lg surface-2 border w-full" style={{ borderColor: "var(--border)" }}>
              {MUSIC.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="block text-xs mb-1" style={{ color: "var(--muted)" }}>Caption style</span>
            <select value={captionStyle} onChange={(e) => setCaptionStyle(e.target.value)}
              className="text-sm px-2 py-2 rounded-lg surface-2 border w-full" style={{ borderColor: "var(--border)" }}>
              {CAPTION_STYLES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="block text-xs mb-1" style={{ color: "var(--muted)" }}>Caption position</span>
            <select value={captionPosition} onChange={(e) => setCaptionPosition(e.target.value)}
              className="text-sm px-2 py-2 rounded-lg surface-2 border w-full" style={{ borderColor: "var(--border)" }}>
              {CAPTION_POSITIONS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="block text-xs mb-1" style={{ color: "var(--muted)" }}>Category</span>
            <select value={category} onChange={(e) => setCategory(e.target.value)}
              className="text-sm px-2 py-2 rounded-lg surface-2 border w-full capitalize" style={{ borderColor: "var(--border)" }}>
              <option value="">— none —</option>
              {categories.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
        </div>
        <p className="text-xs mb-4" style={{ color: "var(--muted)" }}>
          Length is automatic — the story runs as long as it needs to feel complete, capped at ~2 minutes.
        </p>
        </>
        )}

        {format === "cook" && (
        <>
        <label className="block mb-3">
          <span className="block text-xs mb-1" style={{ color: "var(--muted)" }}>Dish</span>
          <textarea
            value={dish}
            onChange={(e) => setDish(e.target.value)}
            rows={2}
            maxLength={200}
            placeholder="e.g. trout grilled on a river stone, campfire flatbread"
            className="w-full px-3 py-2 rounded-lg surface-2 border outline-none text-sm resize-none"
            style={{ borderColor: dish.trim() ? "var(--primary)" : "var(--border)" }}
          />
        </label>
        <div className="flex items-center gap-2 mb-4 flex-wrap">
          <Button onClick={planShots} disabled={planning || dish.trim().length < 3} variant="secondary">
            {planning ? "Planning…" : cookShots.length ? "↻ Re-plan shots" : "🎬 Plan shots"}
          </Button>
          <span className="text-[11px]" style={{ color: "var(--muted)" }}>
            Free to plan — review &amp; edit every prompt before any video is generated.
          </span>
        </div>

        {cookShots.length > 0 && (
          <>
            <label className="block mb-3">
              <span className="block text-xs mb-1" style={{ color: "var(--muted)" }}>Title</span>
              <input value={cookTitle} onChange={(e) => setCookTitle(e.target.value)}
                className="w-full px-3 py-2 rounded-lg surface-2 border outline-none text-sm" style={{ borderColor: "var(--border)" }} />
            </label>
            <div className="mb-3">
              <span className="block text-xs mb-1" style={{ color: "var(--muted)" }}>
                Shots ({cookShots.length}) — edit each prompt; these go to the video model verbatim
              </span>
              <div className="space-y-2">
                {cookShots.map((s, i) => (
                  <div key={i} className="flex gap-2 items-start">
                    <span className="text-[11px] mt-2 w-4 shrink-0 text-right" style={{ color: "var(--muted)" }}>{i + 1}</span>
                    <textarea
                      value={s.prompt}
                      onChange={(e) => setCookShots((prev) => prev.map((p, j) => (j === i ? { prompt: e.target.value } : p)))}
                      rows={5}
                      className="flex-1 px-2.5 py-2 rounded-lg surface-2 border outline-none text-[12px] leading-snug resize-y"
                      style={{ borderColor: "var(--border)" }}
                    />
                    <button
                      onClick={() => setCookShots((prev) => prev.filter((_, j) => j !== i))}
                      className="text-xs mt-2 px-1.5" style={{ color: "var(--danger)" }} title="Remove shot"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            </div>
            <label className="block mb-4 max-w-xs">
              <span className="block text-xs mb-1" style={{ color: "var(--muted)" }}>Category</span>
              <select value={category} onChange={(e) => setCategory(e.target.value)}
                className="text-sm px-2 py-2 rounded-lg surface-2 border w-full capitalize" style={{ borderColor: "var(--border)" }}>
                <option value="">— none —</option>
                {categories.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
            <p className="text-xs mb-4" style={{ color: "var(--muted)" }}>
              {cookShots.length} shots × ~8s ≈ ${(cookShots.length * 0.8).toFixed(2)} on Veo 3.1 Fast. Renders in the
              background — it lands in the Library, track it in the Video Queue.
            </p>
          </>
        )}
        </>
        )}

        <div className="flex items-center gap-3">
          <Button onClick={generate} disabled={busy || !canGenerate}>
            {busy ? "Starting…" : format === "cook" ? "🍳 Generate cook video" : "✨ Generate video"}
          </Button>
          {msg && <span className="text-xs" style={{ color: "var(--muted)" }}>{msg}</span>}
        </div>
      </Card>
    </div>
  );
}
