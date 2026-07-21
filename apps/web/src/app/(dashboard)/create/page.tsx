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
const LENGTHS = [
  { value: "short", label: "Short (~40s)" },
  { value: "medium", label: "Medium (~1 min)" },
  { value: "long", label: "Long (~1.5 min)" },
  { value: "xlong", label: "Extra long (~2 min)" },
];

export default function CreatePage() {
  const { data: cats } = useCategories();
  const categories = (cats ?? []).map((c) => c.name);

  const [topic, setTopic] = useState("");
  const [style, setStyle] = useState("doodle");
  const [narrator, setNarrator] = useState("storyteller");
  const [voiceTier, setVoiceTier] = useState<"standard" | "premium">("standard");
  const [length, setLength] = useState("xlong");
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

  async function generate() {
    if (topic.trim().length < 3) return;
    setBusy(true);
    setMsg(null);
    try {
      await apiSend("/story", "POST", {
        topic: topic.trim(),
        style,
        narrator,
        voiceTier,
        length,
        category: category || undefined,
        captionStyle,
        captionPosition,
        music,
      });
      setMsg("Generating… it'll appear in the Library when done. Track progress in the Video Queue.");
      setTopic("");
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
        subtitle="Generate an original narrated slideshow — AI script, AI voice, AI images. 100% your content, no copyright risk."
      />

      <Card className="mb-6 max-w-2xl">
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
          <label className="block">
            <span className="block text-xs mb-1" style={{ color: "var(--muted)" }}>Length</span>
            <select value={length} onChange={(e) => setLength(e.target.value)}
              className="text-sm px-2 py-2 rounded-lg surface-2 border w-full" style={{ borderColor: "var(--border)" }}>
              {LENGTHS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </label>
        </div>

        <div className="flex items-center gap-3">
          <Button onClick={generate} disabled={busy || topic.trim().length < 3}>
            {busy ? "Starting…" : "✨ Generate video"}
          </Button>
          {msg && <span className="text-xs" style={{ color: "var(--muted)" }}>{msg}</span>}
        </div>
      </Card>
    </div>
  );
}
