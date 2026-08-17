"use client";
import { useState } from "react";
import { apiGet, apiSend, revalidateAll, runPlan, useCategories } from "@/lib/api";
import { Button, Card, PageHeader } from "@/components/ui";
import { ManualClips } from "./ManualClips";

const STYLES = [
  { value: "stick-openai", label: "Stick + colourful (OpenAI)" },
  { value: "stick-fal", label: "Stick + colourful (fal · experimental)" },
  { value: "hero-painterly", label: "Hero — painterly human (fal LoRA)" },
  { value: "anime-fpv", label: "Anime POV — first-person (you)" },
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
/** Gemini prebuilt voices. Gender is a perceived approximation, not a Google label. */
const VOICES = [
  "Zephyr", "Puck", "Charon", "Kore", "Fenrir", "Leda", "Orus", "Aoede", "Callirrhoe", "Autonoe",
  "Enceladus", "Iapetus", "Umbriel", "Algieba", "Despina", "Erinome", "Algenib", "Rasalgethi",
  "Laomedeia", "Achernar", "Alnilam", "Schedar", "Gacrux", "Pulcherrima", "Achird",
  "Zubenelgenubi", "Vindemiatrix", "Sadachbia", "Sadaltager", "Sulafat",
];

interface CallCharacter {
  name: string;
  role: string;
  gender: "male" | "female";
  age: string;
  accent: string;
  voice: string;
  personality: string;
  agenda: string;
  quirks: string;
}
interface AnimShot {
  text: string;
  imagePrompt: string;
  motionPrompt: string;
}

interface CallSpec {
  title: string;
  description: string;
  hashtags: string[];
  premise: string;
  setup: string;
  characters: CallCharacter[];
  escalation: string[];
  ragebait: string[];
  ending: string;
  durationSeconds: number;
  direction: string;
  imagePrompts: string[];
}

const MUSIC = [
  { value: "none", label: "No music" },
  { value: "calm", label: "Calm" },
  { value: "tense", label: "Tense" },
  { value: "upbeat", label: "Upbeat" },
  { value: "epic", label: "Epic" },
];

/** Editable ordered list of one-liners (escalation beats, rage-bait specifics, stills). */
function ListEditor({
  label,
  items,
  onChange,
}: {
  label: string;
  items: string[];
  onChange: (items: string[]) => void;
}) {
  return (
    <div className="mb-3">
      <span className="block text-xs mb-1" style={{ color: "var(--muted)" }}>{label}</span>
      <div className="space-y-1.5">
        {items.map((item, i) => (
          <div key={i} className="flex gap-2 items-start">
            <span className="text-[11px] mt-2 w-4 shrink-0 text-right" style={{ color: "var(--muted)" }}>{i + 1}</span>
            <textarea
              value={item}
              onChange={(e) => onChange(items.map((x, j) => (j === i ? e.target.value : x)))}
              rows={2}
              className="flex-1 px-2.5 py-1.5 rounded-lg surface-2 border outline-none text-[12px] leading-snug resize-y"
              style={{ borderColor: "var(--border)" }}
            />
            <button
              onClick={() => onChange(items.filter((_, j) => j !== i))}
              className="text-xs mt-2 px-1.5"
              style={{ color: "var(--danger)" }}
              title="Remove"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
      <button
        onClick={() => onChange([...items, ""])}
        className="text-[11px] mt-1.5 underline"
        style={{ color: "var(--muted)" }}
      >
        + add
      </button>
    </div>
  );
}

const LOST_SCENE_PRESETS = [
  "a Tuscan hillside village at golden hour, terracotta rooftops, cypress trees and vineyards",
  "a Swiss alpine hamlet in summer, timber chalets with flower boxes, cows in green meadows, snow peaks",
  "a Japanese satoyama mountain village in autumn, tiled farmhouses, rice terraces and a small shrine",
  "a Greek island town at dusk, white cubic houses with blue doors, steps down to a calm sea",
  "a Nepali Himalayan village in morning mist, stone-and-timber houses, terraced fields, prayer flags",
  "an Irish coastal village, whitewashed stone cottages, green cliffs and fishing boats in a small harbour",
  "a Moroccan oasis kasbah at evening, earthen houses, date palms and irrigation channels, warm light",
  "a Vietnamese highland village at dawn, stilt houses, terraced rice paddies and water buffalo in the mist",
  "an English Cotswold village in spring, honey-stone cottages, a village green and a brook",
  "a Scandinavian fjord hamlet, red wooden houses, a jetty on still water, pine forest and steep cliffs",
  "an Andean village in Peru, adobe houses with tiled roofs, terraced fields and llamas on green mountains",
  "a Kerala backwater village, palm-thatched houses along the water, coconut palms and a wooden canoe",
  "a Bavarian alpine village, timber-framed houses, an onion-dome church and wildflower meadows",
  "a Provençal farming village in summer, a stone town, lavender rows and plane trees, cicada heat",
  "a New England coastal village in autumn, clapboard houses, a white steeple and a harbour of small boats",
  "an old Silk Road oasis town at sunset, mud-brick houses, a bustling little bazaar and camels resting",
];

export default function CreatePage() {
  const { data: cats } = useCategories();
  const categories = (cats ?? []).map((c) => c.name);

  const [format, setFormat] = useState<"story" | "video" | "cook">("story");
  const [animShots, setAnimShots] = useState<AnimShot[]>([]);
  const [animMeta, setAnimMeta] = useState<
    { title: string; description: string; hashtags: string[]; setting: string; cast: string } | null
  >(null);
  const [idea, setIdea] = useState("");
  const [call, setCall] = useState<CallSpec | null>(null);
  const [brief, setBrief] = useState("");
  const [showBrief, setShowBrief] = useState(false);
  const [checks, setChecks] = useState<
    { ok: boolean; checks: { purpose: string; provider: string; model: string; ok: boolean; detail: string }[] } | null
  >(null);
  const [checking, setChecking] = useState(false);
  const [dish, setDish] = useState("");
  const [cookShots, setCookShots] = useState<{ prompt: string; imagePrompt?: string }[]>([]);
  const [cookTitle, setCookTitle] = useState("");
  const [cookDescription, setCookDescription] = useState("");
  const [cookHashtags, setCookHashtags] = useState<string[]>([]);
  const [planning, setPlanning] = useState(false);
  const [planSec, setPlanSec] = useState(0);
  // Lost Chronicles (calm anime Veo shorts) — cost-gated: plan (free) → preview
  // still (cheap, iterate) → animate the approved still (one Veo call).
  const [scene, setScene] = useState("");
  const [lostDirection, setLostDirection] = useState("");
  const [lostStill, setLostStill] = useState("");
  const [lostMotion, setLostMotion] = useState("");
  const [lostTitle, setLostTitle] = useState("");
  const [lostDescription, setLostDescription] = useState("");
  const [lostHashtags, setLostHashtags] = useState<string[]>([]);
  const [lostStillUrl, setLostStillUrl] = useState<string | null>(null);
  const [lostStillKey, setLostStillKey] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [lostHint, setLostHint] = useState("");
  const [lostScenes, setLostScenes] = useState<string[]>([]);
  const [suggestingLost, setSuggestingLost] = useState(false);
  const [lostAdjust, setLostAdjust] = useState("");
  const [refiningLost, setRefiningLost] = useState(false);
  const [topic, setTopic] = useState("");
  const [direction, setDirection] = useState("");
  const [mode, setMode] = useState<"scenario" | "story">("scenario");
  const [length, setLength] = useState<"long" | "short">("short");
  const [style, setStyle] = useState("stick-openai");
  const [narrator, setNarrator] = useState("storyteller");
  const [voiceTier, setVoiceTier] = useState<"standard" | "premium">("standard");
  const [category, setCategory] = useState("");
  const [captionStyle, setCaptionStyle] = useState("clean-bottom");
  const [captionPosition, setCaptionPosition] = useState("bottom");
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

  // Only the Slideshow (story) format uses this shared Generate button; Video and
  // Cooking drive their own plan/upload/assemble inside <ManualClips>.
  const canGenerate = format === "story" && topic.trim().length >= 3;

  async function planAnim() {
    if (topic.trim().length < 3) return;
    setPlanning(true);
    setPlanSec(0);
    setMsg(null);
    try {
      const plan = await runPlan<{
        title: string;
        description: string;
        hashtags: string[];
        setting: string;
        cast: string;
        shots: AnimShot[];
      }>("/anim", { topic: topic.trim(), style }, { onTick: setPlanSec });
      setAnimShots(plan.shots);
      setAnimMeta({
        title: plan.title,
        description: plan.description,
        hashtags: plan.hashtags,
        setting: plan.setting,
        cast: plan.cast,
      });
      if (plan.shots.length === 0) setMsg("The planner returned no shots — try a different topic.");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Couldn't plan the animation");
    } finally {
      setPlanning(false);
    }
  }

  /** Pre-flight the paid Google models — a models.get each, so it costs nothing. */
  async function checkProviders() {
    setChecking(true);
    setMsg(null);
    try {
      setChecks(await apiGet("/system/providers"));
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Couldn't reach the API");
    } finally {
      setChecking(false);
    }
  }

  async function planCall() {
    if (idea.trim().length < 3) return;
    setPlanning(true);
    setPlanSec(0);
    setMsg(null);
    try {
      const plan = await runPlan<CallSpec & { brief: string }>(
        "/calls",
        { idea: idea.trim() },
        { onTick: setPlanSec },
      );
      const { brief: b, ...spec } = plan;
      setCall(spec);
      setBrief(b);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Couldn't write the call");
    } finally {
      setPlanning(false);
    }
  }

  /** Re-assemble the brief from the edited fields — same builder the job uses. */
  async function rebuildBrief() {
    if (!call) return;
    setMsg(null);
    try {
      const r = await apiSend<{ brief: string }>("/calls/preview", "POST", call);
      setBrief(r.brief);
      setShowBrief(true);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Couldn't rebuild the brief");
    }
  }

  function patchCall(patch: Partial<CallSpec>) {
    setCall((prev) => (prev ? { ...prev, ...patch } : prev));
  }
  function patchCharacter(i: number, patch: Partial<CallCharacter>) {
    setCall((prev) =>
      prev ? { ...prev, characters: prev.characters.map((c, j) => (j === i ? { ...c, ...patch } : c)) } : prev,
    );
  }

  async function planShots() {
    if (dish.trim().length < 3) return;
    setPlanning(true);
    setPlanSec(0);
    setMsg(null);
    try {
      const plan = await runPlan<{
        title: string;
        description: string;
        hashtags: string[];
        shots: { prompt: string; imagePrompt?: string }[];
      }>(
        "/cook",
        { dish: dish.trim() },
        { onTick: setPlanSec },
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

  // Lost: suggest peaceful lived-in community scenes (present-day + past).
  async function suggestLostScenes() {
    setSuggestingLost(true);
    setMsg(null);
    try {
      const r = await apiGet<{ scenes: string[] }>(
        `/lost/suggest${lostHint.trim() ? `?hint=${encodeURIComponent(lostHint.trim())}` : ""}`,
      );
      setLostScenes(r.scenes);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Couldn't fetch scenes");
    } finally {
      setSuggestingLost(false);
    }
  }

  // Lost: plan the scene → editable still + motion prompts (free text call).
  async function planLost() {
    if (scene.trim().length < 3) return;
    setPlanning(true);
    setPlanSec(0);
    setMsg(null);
    try {
      const plan = await runPlan<{
        stillPrompt: string;
        motionPrompt: string;
        title: string;
        description: string;
        hashtags: string[];
      }>("/lost", { scene: scene.trim(), direction: lostDirection.trim() || undefined }, { onTick: setPlanSec });
      setLostStill(plan.stillPrompt);
      setLostMotion(plan.motionPrompt);
      setLostTitle(plan.title);
      setLostDescription(plan.description);
      setLostHashtags(plan.hashtags);
      // A new plan invalidates any previously-approved still.
      setLostStillUrl(null);
      setLostStillKey(null);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Couldn't plan the scene");
    } finally {
      setPlanning(false);
    }
  }

  // Lost: render the anime still (cheap — iterate until it's perfect BEFORE Veo).
  async function previewLostStill() {
    if (lostStill.trim().length < 3) return;
    setPreviewing(true);
    setMsg(null);
    try {
      const r = await runPlan<{ stillKey: string; url: string }>("/lost/preview", { stillPrompt: lostStill.trim() });
      setLostStillUrl(r.url);
      setLostStillKey(r.stillKey);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Couldn't render the still");
    } finally {
      setPreviewing(false);
    }
  }

  // Lost: keep the current still, add a small detail (image-to-image refine).
  async function refineLostStill() {
    if (!lostStillKey || lostAdjust.trim().length < 2) return;
    setRefiningLost(true);
    setMsg(null);
    try {
      const r = await runPlan<{ stillKey: string; url: string }>("/lost/refine", {
        stillKey: lostStillKey,
        stillPrompt: lostStill.trim(),
        adjustment: lostAdjust.trim(),
      });
      setLostStillUrl(r.url);
      setLostStillKey(r.stillKey);
      setLostAdjust("");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Couldn't refine the still");
    } finally {
      setRefiningLost(false);
    }
  }

  async function generate() {
    if (!canGenerate) return;
    setBusy(true);
    setMsg(null);
    try {
      // Only Slideshow (story) runs through this button; Video + Cooking use ManualClips.
      await apiSend("/story", "POST", {
        topic: topic.trim(),
        direction: direction.trim() || undefined,
        mode,
        length,
        style,
        narrator,
        category: category || undefined,
        captionStyle,
        captionPosition,
      });
      setTopic("");
      setDirection("");
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
        subtitle="Generate an original video — a narrated story slideshow, a cook-in-the-wild clip, or a fictional prank call. 100% your content, no copyright risk."
      />

      <Card className="mb-6 max-w-2xl">
        <div className="flex gap-1 mb-5 p-1 rounded-lg surface-2 border w-fit" style={{ borderColor: "var(--border)" }}>
          {(["story", "video", "cook"] as const).map((f) => (
            <button
              key={f}
              onClick={() => { setFormat(f); setMsg(null); }}
              className="text-sm px-3 py-1.5 rounded-md font-medium transition-colors"
              style={f === format ? { background: "var(--primary)", color: "#fff" } : { color: "var(--muted)" }}
            >
              {f === "story"
                ? "📖 Slideshow"
                : f === "video"
                  ? "🎬 Video"
                  : "🍳 Cooking"}
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

        <label className="block mb-4">
          <span className="block text-xs mb-1" style={{ color: "var(--muted)" }}>Direction (optional)</span>
          <textarea
            value={direction}
            onChange={(e) => setDirection(e.target.value)}
            rows={4}
            maxLength={2000}
            placeholder="how you want it told — what to mention, what to avoid, the angle/tone (e.g. 'focus on the food and the family, keep it very calm, don't mention the war')"
            className="w-full px-3 py-2 rounded-lg surface-2 border outline-none text-sm resize-none"
            style={{ borderColor: "var(--border)" }}
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
            <span className="block text-xs mb-1" style={{ color: "var(--muted)" }}>Type</span>
            <select value={mode} onChange={(e) => setMode(e.target.value as "scenario" | "story")}
              className="text-sm px-2 py-2 rounded-lg surface-2 border w-full" style={{ borderColor: "var(--border)" }}>
              <option value="scenario">Scenario (&quot;imagine you&apos;re a…&quot;)</option>
              <option value="story">True story (with a twist)</option>
            </select>
          </label>
          <label className="block">
            <span className="block text-xs mb-1" style={{ color: "var(--muted)" }}>Format length</span>
            <select value={length} onChange={(e) => setLength(e.target.value as "long" | "short")}
              className="text-sm px-2 py-2 rounded-lg surface-2 border w-full" style={{ borderColor: "var(--border)" }}>
              <option value="long">Long-form (16:9, ~8 min)</option>
              <option value="short">Short (9:16, ~70-90s)</option>
            </select>
          </label>
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
          Long-form: the story runs ~7–9 minutes with a new picture roughly every 3 seconds (~170 stills, about
          $1.00). Narration is recorded in chunks and joined, so length isn&apos;t capped by the voice model.
        </p>
        </>
        )}


        {(format === "video" || format === "cook") && (
          <ManualClips format={format} categories={categories} />
        )}

        {format === "story" && (
          <div className="flex items-center gap-3">
            <Button onClick={generate} disabled={busy || !canGenerate}>
              {busy ? "Starting…" : "✨ Generate video"}
            </Button>
            {msg && <span className="text-xs" style={{ color: "var(--muted)" }}>{msg}</span>}
          </div>
        )}
      </Card>
    </div>
  );
}
