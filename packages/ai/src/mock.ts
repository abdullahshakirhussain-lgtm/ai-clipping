import { deflateSync } from "node:zlib";
import type {
  AnimShot,
  CallAudioProvider,
  CallAudioResult,
  CallPlan,
  CallSpeaker,
  PlanAnimationInput,
  CommentaryLine,
  CookPlan,
  ExpandImagePromptsInput,
  PlanCallInput,
  DescribeVideoContextInput,
  DetectHighlightsInput,
  ImageProvider,
  PlanCookInput,
  PlanPovInput,
  PovPlan,
  RefineImagePromptsInput,
  StoryScript,
  SuggestTopicsInput,
  VideoProvider,
  WriteStoryInput,
  EnhanceClipInput,
  EnhancementResult,
  HighlightCandidate,
  LlmProvider,
  PlanCommentaryInput,
  PlanEnhancementsInput,
  RefineHighlightsInput,
  SfxCue,
  TranscriptionProvider,
  TranscriptionResult,
  TranscriptSegment,
  TtsProvider,
} from "./types.js";

/** Deterministic hash so mock output is stable for the same input. */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

const MOCK_LINES = [
  "So here's the thing nobody tells you about building a company.",
  "I lost everything in year two, and it was the best thing that happened.",
  "The customers you say no to define your brand more than the ones you keep.",
  "We went from zero to a million in revenue with a team of three people.",
  "Stop optimizing your morning routine and start shipping the product.",
  "The investor looked at me and said something I will never forget.",
  "Every founder makes this exact mistake in the first six months.",
  "If I had to start over today, this is the only strategy I would use.",
];

/** Produces a plausible timestamped transcript without calling any API. */
export class MockTranscriptionProvider implements TranscriptionProvider {
  constructor(private readonly durationSecHint = 180) {}

  async transcribe(localFilePath: string): Promise<TranscriptionResult> {
    const seed = hash(localFilePath);
    const segments: TranscriptSegment[] = [];
    const segLen = 5;
    const count = Math.max(6, Math.floor(this.durationSecHint / segLen));
    for (let i = 0; i < count; i++) {
      const text = MOCK_LINES[(seed + i) % MOCK_LINES.length]!;
      const start = i * segLen;
      const end = start + segLen;
      const words = text.split(" ").map((word, wi, arr) => ({
        word,
        start: start + (wi / arr.length) * segLen,
        end: start + ((wi + 1) / arr.length) * segLen,
      }));
      segments.push({ start, end, text, words });
    }
    return {
      language: "en",
      text: segments.map((s) => s.text).join(" "),
      segments,
      provider: "mock",
    };
  }
}

/**
 * Deterministic offline stub for local dev WITHOUT API keys. This is NOT the
 * real detector — it just spaces a few plausible candidates across the transcript
 * so the UI has something to render. Set AI_DRIVER=live for real detection.
 */
export class MockLlmProvider implements LlmProvider {
  async detectHighlights(input: DetectHighlightsInput): Promise<HighlightCandidate[]> {
    const minLen = input.minDurationSec;
    const maxLen = input.maxDurationSec;
    const seed = hash(JSON.stringify(input.segments.slice(0, 2)));
    // Emit a variable (not fixed) number of stub candidates based on length.
    const count = Math.max(1, Math.min(input.segments.length, Math.floor(input.durationSec / 60) + 2));
    const usable = Math.max(input.durationSec - maxLen, minLen);
    const candidates: HighlightCandidate[] = [];
    for (let i = 0; i < count; i++) {
      const start = Math.round(((seed % 97) + i * (usable / count)) % usable);
      const len = minLen + ((seed + i * 13) % Math.max(1, maxLen - minLen));
      const end = Math.min(start + len, input.durationSec);
      if (end - start < minLen) continue;
      const nearSeg = input.segments.find((s) => s.start >= start) ?? input.segments[0];
      candidates.push({
        startSec: start,
        endSec: end,
        hook: nearSeg ? nearSeg.text.slice(0, 80) : "You won't believe what happens next",
        reason: "Mock detector: self-contained moment with a strong opening line",
        topic: ["startups", "money", "mindset", "growth"][(seed + i) % 4]!,
        source: "transcript",
        signals: {
          hookType: "curiosity_gap",
          hookStrength: 55 + ((seed + i) % 40),
          frontLoading: 50 + ((seed + i * 3) % 40),
          selfContained: 50 + ((seed + i * 7) % 45),
          emotion: 45 + ((seed + i * 5) % 50),
          loopability: 40 + ((seed + i * 9) % 50),
        },
      });
    }
    return candidates;
  }

  async refineHighlights(input: RefineHighlightsInput): Promise<number[]> {
    // Offline stub: keep everything (real critique needs the LLM).
    return input.clips.map((c) => c.index);
  }

  async planEnhancements(_input: PlanEnhancementsInput): Promise<SfxCue[]> {
    // Offline stub: no SFX (real placement needs the LLM's judgment).
    return [];
  }

  /**
   * Offline stub. Unlike planEnhancements this returns real lines, so the freeze
   * + mix path actually gets exercised in dev without an API key.
   */
  async planCommentary(input: PlanCommentaryInput): Promise<CommentaryLine[]> {
    const lines: CommentaryLine[] = [];
    const wantsFraming = input.mode === "intro_outro" || input.mode === "full";
    const wantsReacts = input.mode === "interject" || input.mode === "full";
    if (wantsFraming) {
      lines.push({
        atSec: 0,
        text: "Okay, you need context for this one.",
        role: "intro",
        delivery: "Conspiratorial, leaning in, half-suppressed grin.",
        intensity: "quiet",
      });
    }
    if (wantsReacts) {
      lines.push({
        atSec: input.durationSec / 2,
        // Tagged only for tag-speaking providers; others get clean prose.
        text: input.voiceTags
          ? "[scoffs] And that's where... [shouting] IT FALLS APART."
          : "And that's where it falls apart.",
        role: "react",
        delivery: "Disbelief building fast, almost a shout on the last word.",
        intensity: "loud",
      });
    }
    if (wantsFraming) {
      lines.push({
        atSec: input.durationSec,
        text: "Wild that anyone believed it.",
        role: "outro",
        delivery: "Slow, dry, verdict delivered while walking away.",
        intensity: "normal",
      });
    }
    return lines;
  }

  async describeVideoContext(_input: DescribeVideoContextInput): Promise<string> {
    // Offline stub: reading on-screen text needs real vision.
    return "";
  }

  async enhanceClip(input: EnhanceClipInput): Promise<EnhancementResult> {
    return {
      title: `${input.hook.replace(/[.!?]+$/, "").slice(0, 60)}`,
      description: `${input.hook} — full breakdown in this clip. Follow for more ${input.topic} content.`,
      hashtags: ["#" + input.topic, "#viral", "#clips", "#fyp", "#shorts"].slice(0, 5),
      hookVariants: [
        input.hook,
        `POV: ${input.hook.charAt(0).toLowerCase()}${input.hook.slice(1)}`,
        `The truth about ${input.topic} nobody says out loud`,
      ],
      model: "mock",
    };
  }

  async improveHooks(input: { currentHook: string; transcriptExcerpt: string }): Promise<string[]> {
    return [
      `Wait — ${input.currentHook.charAt(0).toLowerCase()}${input.currentHook.slice(1)}`,
      `Nobody is ready for this: ${input.currentHook}`,
      `${input.currentHook} (watch till the end)`,
    ];
  }

  async suggestStoryTopics(input: SuggestTopicsInput): Promise<string[]> {
    const base = input.category ? `${input.category}: ` : "";
    return Array.from({ length: input.count }, (_, i) => `${base}A wild true story #${i + 1}`);
  }

  async writeStory(input: WriteStoryInput): Promise<StoryScript> {
    // Offline stub: pick a mid count within the cap (the writer floats this live).
    const n = Math.max(5, Math.min(input.maxBeats, 8));
    const beats = Array.from({ length: n }, (_, i) => ({
      // Beat 1 is a valid cold open (starts with a mandated stem) so the
      // pipeline's opening check passes; the rest just build tension.
      text:
        i === 0
          ? input.voiceTags
            ? `[curious] Imagine standing right in the middle of ${input.topic}. [pause] Something is about to go very wrong.`
            : `Imagine standing right in the middle of ${input.topic}. Something is about to go very wrong.`
          : input.voiceTags
            ? `[curious] Beat ${i + 1} of the story about ${input.topic}. [pause] Something surprising happens.`
            : `Beat ${i + 1} of the story about ${input.topic}. Something surprising happens here.`,
      imagePrompt: `Beat ${i + 1}: our recurring character reacting to ${input.topic} within the scene.`,
      delivery: i === 0 ? "Open with curiosity, slow and inviting." : `Build tension, beat ${i + 1}.`,
    }));
    return {
      title: `The untold story of ${input.topic}`,
      script: beats.map((b) => b.text).join(" "),
      description: `A quick story about ${input.topic}. Follow for more.`,
      hashtags: ["#story", "#didyouknow", "#fyp", "#shorts"],
      setting: `The concrete world of ${input.topic}: its real place, era, objects and a recurring main character.`,
      beats,
    };
  }

  async planCookShots(input: PlanCookInput): Promise<CookPlan> {
    const n = Math.max(3, Math.min(input.maxShots, 5));
    const bible = `MOCK cook-in-the-wild bible for "${input.dish}": riverside, flat stone on a fire, weathered hands only, soft even light, nothing appears mid-shot.`;
    const shots = Array.from({ length: n }, (_, i) => ({
      prompt: `${bible}\nACTION: mock cooking step ${i + 1} for ${input.dish}.\nAUDIO: ambient nature sounds.`,
    }));
    return {
      title: `${input.dish} in the wild`,
      description: `Cooking ${input.dish} outdoors, no talking. Follow for more.`,
      hashtags: ["#cooking", "#asmr", "#wild", "#fyp"],
      shots,
    };
  }

  async planPovShort(input: PlanPovInput): Promise<PovPlan> {
    const n = Math.max(8, Math.min(input.maxShots, 16));
    const arc = [
      { scene: "a dim interior, a low bed and shuttered window", motion: "you sit up, hands pushing off the bed" },
      { scene: "the room around you, a chest and a lamp", motion: "you rise and cross toward the shutters" },
      { scene: "the closed shutters ahead of you", motion: "your hands push the shutters open onto the view" },
      { scene: "the wider world beyond the window", motion: "you lean out and look across it" },
      { scene: "a doorway onto the street", motion: "you step through the door into the open" },
      { scene: "a busy lane of the old city", motion: "you walk down the lane past the crowd" },
      { scene: "a market stall of goods", motion: "your hand reaches toward the goods on the stall" },
      { scene: "stone steps rising ahead", motion: "you climb the steps toward a landmark" },
    ];
    // Extend to n by cycling the "moving through the world" beats.
    const shots = Array.from({ length: n }, (_, i) => ({
      ...arc[Math.min(i, arc.length - 1)]!,
      audio: "quiet ambient room tone, then the world outside",
    }));
    return {
      title: `POV: you wake up in ${input.topic}`,
      description: `You wake up in ${input.topic}. Where should you wake up next?`,
      hashtags: ["#pov", "#history", "#fyp"],
      logline: `You wake as an ordinary person in ${input.topic} and walk out through the world as it comes alive around you.`,
      place: input.topic,
      date: "a real date",
      timeOfDay: "Dawn",
      role: "an ordinary person",
      worldBible: `MOCK world lock for ${input.topic}: clear cold dawn, low golden light from the east, your own flat stick-figure hands in a plain grey sleeve, same weather every clip.`,
      shots,
    };
  }

  async expandImagePrompts(input: ExpandImagePromptsInput): Promise<string[][]> {
    // Distinct SHOT TYPES (not the same frame nudged), cycling wide → close-up →
    // detail, so the mock exercises the real fast-cadence path.
    const shots = ["wide establishing shot", "tight close-up on the character's face", "detail shot of the key object"];
    return input.beats.map((b) =>
      Array.from({ length: b.count }, (_, k) => `${shots[k % shots.length]}: ${b.imagePrompt}`),
    );
  }

  async refineImagePrompts(input: RefineImagePromptsInput): Promise<string[]> {
    // Offline stub: draw exactly the line, in the story's world.
    return input.beats.map((b) => `${b.text.trim()} — ${input.setting}`.trim());
  }

  async planAnimationShots(input: PlanAnimationInput): Promise<{ cast: string; shots: AnimShot[] }> {
    const cast = "MOCK CAST: the tall figure in the brown coat; the shorter figure with the satchel.";
    return {
      cast,
      shots: input.beats.map((b) => ({
        text: b.text,
        imagePrompt: `CAST (unchanged in every shot):\n${cast}\n\n${b.imagePrompt} (mock first frame)`,
        motionPrompt: `mock motion: the figures act out "${b.text.slice(0, 40)}"`,
      })),
    };
  }

  async planCall(input: PlanCallInput): Promise<CallPlan> {
    return {
      title: `MOCK call: ${input.idea}`,
      description: "A fictional, AI-generated phone call. Not a real recording.",
      hashtags: ["#prankcall", "#ai", "#fyp"],
      premise: `MOCK premise for "${input.idea}".`,
      setup: "A mock call between two mock people about a mock problem.",
      characters: [
        {
          name: "Dave",
          role: "the caller",
          gender: "male",
          age: "late 40s",
          accent: "flat mock accent, talks over people",
          voice: "Charon",
          personality: "certain he is right",
          agenda: "get the refund",
          quirks: 'says "listen to me" constantly',
        },
        {
          name: "Priya",
          role: "the agent",
          gender: "female",
          age: "early 30s",
          accent: "calm, clipped, unbothered",
          voice: "Kore",
          personality: "immovably polite",
          agenda: "follow the policy",
          quirks: 'repeats "I understand your frustration"',
        },
      ],
      escalation: ["polite opening", "the policy is quoted", "voice raised", "the line goes quiet"],
      ragebait: ["a $4 fee", "a rule invented on the spot", "the hold music"],
      ending: "cuts mid-sentence",
      durationSeconds: Math.min(input.maxSeconds, 45),
      direction: "overlapping, phone-line quality, no narration",
      imagePrompts: ["a man on a phone at a kitchen table", "a woman at a desk with a headset", "a phone face-down on a table"],
    };
  }
}

/** Offline call audio: a short silent wav + a stub transcript, so the Call
 *  pipeline assembles a real video with no key set. */
export class MockCallProvider implements CallAudioProvider {
  async generate(input: { brief: string; speakers: CallSpeaker[]; targetSeconds: number }): Promise<CallAudioResult> {
    const [a, b] = input.speakers;
    const lines = [
      { speaker: a?.name ?? "A", text: "Mock line one, this is the mock call." },
      { speaker: b?.name ?? "B", text: "Mock reply, I understand your frustration." },
      { speaker: a?.name ?? "A", text: "Mock escalation, listen to me." },
      { speaker: b?.name ?? "B", text: "Mock final line before it cuts." },
    ];
    return {
      audio: silentWav(Math.max(4, Math.min(input.targetSeconds, 60))),
      ext: "wav",
      transcript: lines.map((l) => `${l.speaker}: ${l.text}`).join("\n"),
      lines,
    };
  }
}

/**
 * Offline image stub: a valid solid-colour PNG so the assembler runs keyless.
 * Colour varies by prompt hash so successive beats look different in a mock run.
 */
export class MockImageProvider implements ImageProvider {
  async generate(input: { prompt: string; size?: string }): Promise<{ image: Buffer; ext: "png" }> {
    const hue = hash(input.prompt) % 6;
    const palette: Array<[number, number, number]> = [
      [230, 120, 120],
      [120, 200, 230],
      [140, 220, 150],
      [235, 200, 120],
      [200, 150, 230],
      [120, 220, 210],
    ];
    return { image: solidPng(64, 96, palette[hue]!), ext: "png" };
  }
}

/** A tiny valid 1s mp4 (360x640, grey, silent stereo aac) — precomputed, so the
 *  cook pipeline assembles and stores real video keyless. */
const MOCK_MP4_B64 =
  "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";

/** Offline video stub: returns the precomputed mp4 so the cook pipeline runs keyless. */
export class MockVideoProvider implements VideoProvider {
  async generate(_input: { prompt: string; aspectRatio?: string }): Promise<{ video: Buffer; ext: "mp4" }> {
    return { video: Buffer.from(MOCK_MP4_B64, "base64"), ext: "mp4" };
  }
}

/**
 * Minimal PNG of a solid RGB colour (w×h), valid for ffmpeg — proper CRCs and
 * zlib-deflated scanlines. Exported: also the pipeline's fallback card when a
 * beat's image generation fails (a hand-crafted base64 stub used there once
 * shipped a truncated IDAT and crashed the whole assembly).
 */
export function solidPng(width: number, height: number, [r, g, b]: [number, number, number]): Buffer {
  const crcTable = (() => {
    const t: number[] = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  const crc32 = (buf: Buffer): number => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, "ascii");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([len, typeBuf, data, crc]);
  };
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(2, 9); // colour type 2 = RGB
  // rows: each prefixed with filter byte 0, then w*3 bytes
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 3);
    raw[rowStart] = 0;
    for (let x = 0; x < width; x++) {
      const p = rowStart + 1 + x * 3;
      raw[p] = r;
      raw[p + 1] = g;
      raw[p + 2] = b;
    }
  }
  const idat = deflateSync(raw);
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

/** A valid silent PCM WAV of `seconds` — enough for ffprobe/ffmpeg to work with. */
function silentWav(seconds: number): Buffer {
  const sampleRate = 16000;
  const channels = 1;
  const bytesPerSample = 2; // 16-bit
  const samples = Math.max(1, Math.round(seconds * sampleRate));
  const dataSize = samples * channels * bytesPerSample;
  const buf = Buffer.alloc(44 + dataSize); // body stays zeroed = silence
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16); // PCM fmt chunk size
  buf.writeUInt16LE(1, 20); // format = PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channels * bytesPerSample, 28); // byte rate
  buf.writeUInt16LE(channels * bytesPerSample, 32); // block align
  buf.writeUInt16LE(bytesPerSample * 8, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  return buf;
}

/**
 * Offline TTS: silence sized to how long the line would plausibly take to say
 * (~15 chars/sec). The pipeline can then plan freezes, mix, and be verified
 * end-to-end without an API key or spending anything.
 */
export class MockTtsProvider implements TtsProvider {
  async synthesize(input: { text: string }): Promise<{ audio: Buffer; ext: "wav" }> {
    const seconds = Math.min(12, Math.max(1, input.text.length / 15));
    return { audio: silentWav(seconds), ext: "wav" };
  }
}
