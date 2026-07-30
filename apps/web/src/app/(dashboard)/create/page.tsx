"use client";
import { useState } from "react";
import { apiGet, apiSend, revalidateAll, runPlan, useCategories } from "@/lib/api";
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

export default function CreatePage() {
  const { data: cats } = useCategories();
  const categories = (cats ?? []).map((c) => c.name);

  const [format, setFormat] = useState<"story" | "cook" | "call" | "anim">("story");
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
  const [topic, setTopic] = useState("");
  const [length, setLength] = useState<"long" | "short">("long");
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

  const canGenerate =
    format === "story"
      ? topic.trim().length >= 3
      : format === "cook"
        ? cookShots.length > 0
        : format === "anim"
          ? animShots.length > 0
          : !!call && brief.trim().length > 20;

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

  async function generate() {
    if (!canGenerate) return;
    setBusy(true);
    setMsg(null);
    try {
      if (format === "anim") {
        await apiSend("/anim", "POST", {
          topic: topic.trim(),
          title: animMeta?.title,
          description: animMeta?.description,
          hashtags: animMeta?.hashtags,
          setting: animMeta?.setting,
          cast: animMeta?.cast,
          shots: animShots,
          style,
          narrator,
          voiceTier,
          music,
          category: category || undefined,
          captionStyle,
          captionPosition,
        });
        setTopic("");
        setAnimShots([]);
        setAnimMeta(null);
      } else if (format === "call") {
        await apiSend("/calls", "POST", {
          ...call,
          brief,
          category: category || undefined,
          captionStyle,
          captionPosition,
        });
        setIdea("");
        setCall(null);
        setBrief("");
      } else if (format === "cook") {
        await apiSend("/cook", "POST", {
          dish: dish.trim(),
          title: cookTitle || undefined,
          description: cookDescription || undefined,
          hashtags: cookHashtags,
          shots: cookShots.map((s) => ({ prompt: s.prompt, imagePrompt: s.imagePrompt })),
          category: category || undefined,
        });
        setDish("");
        setCookShots([]);
        setCookTitle("");
        setCookDescription("");
      } else {
        await apiSend("/story", "POST", {
          topic: topic.trim(),
          length,
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
        subtitle="Generate an original video — a narrated story slideshow, a cook-in-the-wild clip, or a fictional prank call. 100% your content, no copyright risk."
      />

      <Card className="mb-6 max-w-2xl">
        <div className="flex gap-1 mb-5 p-1 rounded-lg surface-2 border w-fit" style={{ borderColor: "var(--border)" }}>
          {(["story", "anim", "cook", "call"] as const).map((f) => (
            <button
              key={f}
              onClick={() => { setFormat(f); setMsg(null); }}
              className="text-sm px-3 py-1.5 rounded-md font-medium transition-colors"
              style={f === format ? { background: "var(--primary)", color: "#fff" } : { color: "var(--muted)" }}
            >
              {f === "story"
                ? "📖 Slideshow"
                : f === "anim"
                  ? "🎬 Animated short"
                  : f === "cook"
                    ? "🍳 Cook clip"
                    : "📞 Prank call"}
            </button>
          ))}
        </div>

        {(format === "cook" || format === "call" || format === "anim") && (
          <div className="mb-5">
            <div className="flex items-center gap-2 flex-wrap">
              <Button onClick={checkProviders} disabled={checking} variant="secondary">
                {checking ? "Checking…" : "🔌 Check API models"}
              </Button>
              <span className="text-[11px]" style={{ color: "var(--muted)" }}>
                Confirms the Google key can see the exact models before you spend anything on a render.
              </span>
            </div>
            {checks && (
              <div className="mt-2 space-y-1">
                {checks.checks.map((c) => (
                  <div key={c.purpose + c.model} className="text-[11px] flex gap-2">
                    <span>{c.ok ? "✅" : "❌"}</span>
                    <span style={{ color: "var(--muted)" }}>{c.purpose}</span>
                    <code>{c.model}</code>
                    <span style={{ color: "var(--muted)" }}>{c.detail}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

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
          Long-form: the story runs ~7–9 minutes with a new picture roughly every 3 seconds (~170 stills, about
          $1.00). Narration is recorded in chunks and joined, so length isn&apos;t capped by the voice model.
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
            {planning ? `Planning… ${planSec}s` : cookShots.length ? "↻ Re-plan shots" : "🎬 Plan shots"}
          </Button>
          <span className="text-[11px]" style={{ color: "var(--muted)" }}>
            {planning
              ? "Thinking through the shot list — this takes a couple of minutes. Leave the page open."
              : "Free to plan — review & edit every prompt before any video is generated."}
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
                    <div className="flex-1 space-y-1.5">
                      <div>
                        <span className="block text-[10px] mb-0.5" style={{ color: "var(--muted)" }}>
                          First frame — the still that gets drawn, then animated
                        </span>
                        <textarea
                          value={s.imagePrompt ?? ""}
                          onChange={(e) =>
                            setCookShots((prev) => prev.map((p, j) => (j === i ? { ...p, imagePrompt: e.target.value } : p)))
                          }
                          rows={4}
                          className="w-full px-2.5 py-2 rounded-lg surface-2 border outline-none text-[12px] leading-snug resize-y"
                          style={{ borderColor: "var(--border)" }}
                        />
                      </div>
                      <div>
                        <span className="block text-[10px] mb-0.5" style={{ color: "var(--muted)" }}>
                          Motion — what happens across the 8 seconds
                        </span>
                        <textarea
                          value={s.prompt}
                          onChange={(e) =>
                            setCookShots((prev) => prev.map((p, j) => (j === i ? { ...p, prompt: e.target.value } : p)))
                          }
                          rows={5}
                          className="w-full px-2.5 py-2 rounded-lg surface-2 border outline-none text-[12px] leading-snug resize-y"
                          style={{ borderColor: "var(--border)" }}
                        />
                      </div>
                    </div>
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
              {cookShots.length} shots × ~8s = {cookShots.length * 8}s ≈ $
              {(cookShots.length * 0.8 + cookShots.length * 0.039).toFixed(2)} on Veo 3.1 Fast (clips + first-frame
              stills). Each still is drawn as an edit of the one before it, so the stone, fire and props stay put across
              cuts. Renders in the background — it lands in the Library, track it in the Video Queue.
            </p>
          </>
        )}
        </>
        )}

        {format === "anim" && (
        <>
        <label className="block mb-3">
          <span className="block text-xs mb-1" style={{ color: "var(--muted)" }}>Topic</span>
          <textarea
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            rows={2}
            maxLength={300}
            placeholder="e.g. the diver who found a WWII submarine in a lake"
            className="w-full px-3 py-2 rounded-lg surface-2 border outline-none text-sm resize-none"
            style={{ borderColor: topic.trim() ? "var(--primary)" : "var(--border)" }}
          />
        </label>
        <div className="flex items-center gap-2 mb-4 flex-wrap">
          <Button onClick={planAnim} disabled={planning || topic.trim().length < 3} variant="secondary">
            {planning ? `Planning… ${planSec}s` : animShots.length ? "↻ Re-plan" : "🎬 Plan the animation"}
          </Button>
          <span className="text-[11px]" style={{ color: "var(--muted)" }}>
            {planning
              ? "Writing the story, then the shot list — a couple of minutes. Leave the page open."
              : "Free to plan. Each beat becomes one ~8s animated clip; review every prompt before anything is generated."}
          </span>
        </div>

        {animShots.length > 0 && (
          <>
            {animMeta && (
              <label className="block mb-3">
                <span className="block text-xs mb-1" style={{ color: "var(--muted)" }}>Title</span>
                <input value={animMeta.title} onChange={(e) => setAnimMeta({ ...animMeta, title: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg surface-2 border outline-none text-sm" style={{ borderColor: "var(--border)" }} />
              </label>
            )}
            {animMeta && (
              <label className="block mb-4">
                <span className="block text-xs mb-1" style={{ color: "var(--muted)" }}>
                  World — repeated into every frame so the look holds across clips
                </span>
                <textarea value={animMeta.setting} onChange={(e) => setAnimMeta({ ...animMeta, setting: e.target.value })} rows={2}
                  className="w-full px-3 py-2 rounded-lg surface-2 border outline-none text-sm resize-y" style={{ borderColor: "var(--border)" }} />
              </label>
            )}
            {animMeta && (
              <label className="block mb-4">
                <span className="block text-xs mb-1" style={{ color: "var(--muted)" }}>
                  Cast — how each figure looks, repeated into every shot. This is what keeps them
                  recognisable across clips, so keep the descriptions concrete and distinct.
                </span>
                <textarea value={animMeta.cast} onChange={(e) => setAnimMeta({ ...animMeta, cast: e.target.value })} rows={3}
                  className="w-full px-3 py-2 rounded-lg surface-2 border outline-none text-sm resize-y" style={{ borderColor: "var(--border)" }} />
              </label>
            )}
            <div className="mb-3">
              <span className="block text-xs mb-2" style={{ color: "var(--muted)" }}>
                {animShots.length} beats — each becomes one ~8s clip
              </span>
              <div className="space-y-3">
                {animShots.map((s, i) => (
                  <div key={i} className="p-3 rounded-lg surface-2 border space-y-2" style={{ borderColor: "var(--border)" }}>
                    <div className="flex items-start gap-2">
                      <span className="text-[11px] mt-2 w-4 shrink-0 text-right" style={{ color: "var(--muted)" }}>{i + 1}</span>
                      <div className="flex-1 space-y-2">
                        <div>
                          <span className="block text-[10px] mb-0.5" style={{ color: "var(--muted)" }}>Narration</span>
                          <textarea
                            value={s.text}
                            onChange={(e) => setAnimShots((p) => p.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))}
                            rows={2}
                            className="w-full px-2.5 py-1.5 rounded surface-1 border outline-none text-[12px] leading-snug resize-y"
                            style={{ borderColor: "var(--border)" }}
                          />
                        </div>
                        <div>
                          <span className="block text-[10px] mb-0.5" style={{ color: "var(--muted)" }}>First frame</span>
                          <textarea
                            value={s.imagePrompt}
                            onChange={(e) => setAnimShots((p) => p.map((x, j) => (j === i ? { ...x, imagePrompt: e.target.value } : x)))}
                            rows={3}
                            className="w-full px-2.5 py-1.5 rounded surface-1 border outline-none text-[12px] leading-snug resize-y"
                            style={{ borderColor: "var(--border)" }}
                          />
                        </div>
                        <div>
                          <span className="block text-[10px] mb-0.5" style={{ color: "var(--muted)" }}>Motion — what moves over the 8s</span>
                          <textarea
                            value={s.motionPrompt}
                            onChange={(e) => setAnimShots((p) => p.map((x, j) => (j === i ? { ...x, motionPrompt: e.target.value } : x)))}
                            rows={3}
                            className="w-full px-2.5 py-1.5 rounded surface-1 border outline-none text-[12px] leading-snug resize-y"
                            style={{ borderColor: "var(--border)" }}
                          />
                        </div>
                      </div>
                      <button
                        onClick={() => setAnimShots((p) => p.filter((_, j) => j !== i))}
                        className="text-xs mt-2 px-1.5" style={{ color: "var(--danger)" }} title="Remove beat"
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3 mb-4">
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
              {animShots.length} clips × ~8s = {animShots.length * 8}s ≈ ${(animShots.length * 0.4).toFixed(2)} on Veo 3.1
              Lite. Each clip starts from its own drawn frame, so the figures stay the same across cuts, and the video
              model&apos;s own audio is dropped in favour of the narration.
            </p>
          </>
        )}
        </>
        )}

        {format === "call" && (
        <>
        <label className="block mb-3">
          <span className="block text-xs mb-1" style={{ color: "var(--muted)" }}>The idea — one line is enough</span>
          <textarea
            value={idea}
            onChange={(e) => setIdea(e.target.value)}
            rows={2}
            maxLength={300}
            placeholder="e.g. rage bait a scammer who called about my car warranty"
            className="w-full px-3 py-2 rounded-lg surface-2 border outline-none text-sm resize-none"
            style={{ borderColor: idea.trim() ? "var(--primary)" : "var(--border)" }}
          />
        </label>
        <div className="flex items-center gap-2 mb-4 flex-wrap">
          <Button onClick={planCall} disabled={planning || idea.trim().length < 3} variant="secondary">
            {planning ? `Writing… ${planSec}s` : call ? "↻ Re-write the call" : "🎭 Write the call"}
          </Button>
          <span className="text-[11px]" style={{ color: "var(--muted)" }}>
            {planning
              ? "Casting and writing the escalation — this takes a couple of minutes. Leave the page open."
              : "Free to plan. The AI picks the cast, accents, voices and escalation — all of it editable below."}
          </span>
        </div>

        {call && (
          <>
            <label className="block mb-3">
              <span className="block text-xs mb-1" style={{ color: "var(--muted)" }}>Title</span>
              <input value={call.title} onChange={(e) => patchCall({ title: e.target.value })}
                className="w-full px-3 py-2 rounded-lg surface-2 border outline-none text-sm" style={{ borderColor: "var(--border)" }} />
            </label>
            <label className="block mb-3">
              <span className="block text-xs mb-1" style={{ color: "var(--muted)" }}>Premise</span>
              <input value={call.premise} onChange={(e) => patchCall({ premise: e.target.value })}
                className="w-full px-3 py-2 rounded-lg surface-2 border outline-none text-sm" style={{ borderColor: "var(--border)" }} />
            </label>
            <label className="block mb-4">
              <span className="block text-xs mb-1" style={{ color: "var(--muted)" }}>Setup — what the viewer must get in 3 seconds</span>
              <textarea value={call.setup} onChange={(e) => patchCall({ setup: e.target.value })} rows={2}
                className="w-full px-3 py-2 rounded-lg surface-2 border outline-none text-sm resize-y" style={{ borderColor: "var(--border)" }} />
            </label>

            <div className="mb-4 space-y-3">
              <span className="block text-xs" style={{ color: "var(--muted)" }}>
                The two voices — different accent, tempo and vocabulary is what makes them read as real people
              </span>
              {call.characters.map((c, i) => (
                <div key={i} className="p-3 rounded-lg surface-2 border space-y-2" style={{ borderColor: "var(--border)" }}>
                  <div className="grid grid-cols-4 gap-2">
                    <label className="block">
                      <span className="block text-[10px] mb-0.5" style={{ color: "var(--muted)" }}>Name</span>
                      <input value={c.name} onChange={(e) => patchCharacter(i, { name: e.target.value })}
                        className="w-full px-2 py-1.5 rounded surface-1 border outline-none text-xs" style={{ borderColor: "var(--border)" }} />
                    </label>
                    <label className="block">
                      <span className="block text-[10px] mb-0.5" style={{ color: "var(--muted)" }}>Gender</span>
                      <select value={c.gender} onChange={(e) => patchCharacter(i, { gender: e.target.value as "male" | "female" })}
                        className="w-full px-2 py-1.5 rounded surface-1 border text-xs" style={{ borderColor: "var(--border)" }}>
                        <option value="male">male</option>
                        <option value="female">female</option>
                      </select>
                    </label>
                    <label className="block">
                      <span className="block text-[10px] mb-0.5" style={{ color: "var(--muted)" }}>Age</span>
                      <input value={c.age} onChange={(e) => patchCharacter(i, { age: e.target.value })}
                        className="w-full px-2 py-1.5 rounded surface-1 border outline-none text-xs" style={{ borderColor: "var(--border)" }} />
                    </label>
                    <label className="block">
                      <span className="block text-[10px] mb-0.5" style={{ color: "var(--muted)" }}>Voice</span>
                      <select value={c.voice} onChange={(e) => patchCharacter(i, { voice: e.target.value })}
                        className="w-full px-2 py-1.5 rounded surface-1 border text-xs" style={{ borderColor: "var(--border)" }}>
                        {VOICES.map((v) => <option key={v} value={v}>{v}</option>)}
                      </select>
                    </label>
                  </div>
                  <label className="block">
                    <span className="block text-[10px] mb-0.5" style={{ color: "var(--muted)" }}>Role</span>
                    <input value={c.role} onChange={(e) => patchCharacter(i, { role: e.target.value })}
                      className="w-full px-2 py-1.5 rounded surface-1 border outline-none text-xs" style={{ borderColor: "var(--border)" }} />
                  </label>
                  <label className="block">
                    <span className="block text-[10px] mb-0.5" style={{ color: "var(--muted)" }}>Accent &amp; delivery</span>
                    <textarea value={c.accent} onChange={(e) => patchCharacter(i, { accent: e.target.value })} rows={2}
                      className="w-full px-2 py-1.5 rounded surface-1 border outline-none text-xs resize-y" style={{ borderColor: "var(--border)" }} />
                  </label>
                  <div className="grid grid-cols-3 gap-2">
                    <label className="block">
                      <span className="block text-[10px] mb-0.5" style={{ color: "var(--muted)" }}>Personality</span>
                      <textarea value={c.personality} onChange={(e) => patchCharacter(i, { personality: e.target.value })} rows={2}
                        className="w-full px-2 py-1.5 rounded surface-1 border outline-none text-xs resize-y" style={{ borderColor: "var(--border)" }} />
                    </label>
                    <label className="block">
                      <span className="block text-[10px] mb-0.5" style={{ color: "var(--muted)" }}>Wants</span>
                      <textarea value={c.agenda} onChange={(e) => patchCharacter(i, { agenda: e.target.value })} rows={2}
                        className="w-full px-2 py-1.5 rounded surface-1 border outline-none text-xs resize-y" style={{ borderColor: "var(--border)" }} />
                    </label>
                    <label className="block">
                      <span className="block text-[10px] mb-0.5" style={{ color: "var(--muted)" }}>Speech habits</span>
                      <textarea value={c.quirks} onChange={(e) => patchCharacter(i, { quirks: e.target.value })} rows={2}
                        className="w-full px-2 py-1.5 rounded surface-1 border outline-none text-xs resize-y" style={{ borderColor: "var(--border)" }} />
                    </label>
                  </div>
                </div>
              ))}
            </div>

            <ListEditor
              label="How it escalates (beats, not lines)"
              items={call.escalation}
              onChange={(escalation) => patchCall({ escalation })}
            />
            <ListEditor
              label="The details that make people comment"
              items={call.ragebait}
              onChange={(ragebait) => patchCall({ ragebait })}
            />

            <div className="grid grid-cols-2 gap-3 mb-3">
              <label className="block">
                <span className="block text-xs mb-1" style={{ color: "var(--muted)" }}>Ending — cut on the peak</span>
                <textarea value={call.ending} onChange={(e) => patchCall({ ending: e.target.value })} rows={2}
                  className="w-full px-3 py-2 rounded-lg surface-2 border outline-none text-sm resize-y" style={{ borderColor: "var(--border)" }} />
              </label>
              <label className="block">
                <span className="block text-xs mb-1" style={{ color: "var(--muted)" }}>Performance direction</span>
                <textarea value={call.direction} onChange={(e) => patchCall({ direction: e.target.value })} rows={2}
                  className="w-full px-3 py-2 rounded-lg surface-2 border outline-none text-sm resize-y" style={{ borderColor: "var(--border)" }} />
              </label>
            </div>

            <ListEditor
              label="On-screen stills (the video is audio-led)"
              items={call.imagePrompts}
              onChange={(imagePrompts) => patchCall({ imagePrompts })}
            />

            <div className="grid grid-cols-3 gap-3 mb-4">
              <label className="block">
                <span className="block text-xs mb-1" style={{ color: "var(--muted)" }}>Length (s)</span>
                <input type="number" min={20} max={90} value={call.durationSeconds}
                  onChange={(e) => patchCall({ durationSeconds: Math.max(20, Math.min(90, Number(e.target.value) || 45)) })}
                  className="w-full px-2 py-2 rounded-lg surface-2 border outline-none text-sm" style={{ borderColor: "var(--border)" }} />
              </label>
              <label className="block">
                <span className="block text-xs mb-1" style={{ color: "var(--muted)" }}>Caption style</span>
                <select value={captionStyle} onChange={(e) => setCaptionStyle(e.target.value)}
                  className="text-sm px-2 py-2 rounded-lg surface-2 border w-full" style={{ borderColor: "var(--border)" }}>
                  {CAPTION_STYLES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
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

            <div className="flex items-center gap-2 mb-2 flex-wrap">
              <Button onClick={rebuildBrief} variant="secondary">↻ Rebuild brief from fields</Button>
              <button onClick={() => setShowBrief((s) => !s)} className="text-xs underline" style={{ color: "var(--muted)" }}>
                {showBrief ? "Hide" : "Show"} the exact prompt that gets sent
              </button>
            </div>
            {showBrief && (
              <textarea
                value={brief}
                onChange={(e) => setBrief(e.target.value)}
                rows={18}
                className="w-full px-2.5 py-2 mb-3 rounded-lg surface-2 border outline-none text-[12px] leading-snug resize-y font-mono"
                style={{ borderColor: "var(--border)" }}
              />
            )}
            <p className="text-xs mb-4" style={{ color: "var(--muted)" }}>
              This brief is sent verbatim — the voice model improvises the dialogue from it, which is why it reads like a
              real call instead of a script. ~{call.durationSeconds}s ≈ 2¢ of Gemini audio. Keep it clearly fictional:
              invented names only, and label it as AI-made in the caption.
            </p>
          </>
        )}
        </>
        )}

        <div className="flex items-center gap-3">
          <Button onClick={generate} disabled={busy || !canGenerate}>
            {busy
              ? "Starting…"
              : format === "cook"
                ? "🍳 Generate cook video"
                : format === "call"
                  ? "📞 Make the call"
                  : format === "anim"
                    ? "🎬 Animate it"
                    : "✨ Generate video"}
          </Button>
          {msg && <span className="text-xs" style={{ color: "var(--muted)" }}>{msg}</span>}
        </div>
      </Card>
    </div>
  );
}
