import type {
  DetectHighlightsInput,
  EnhanceClipInput,
  EnhancementResult,
  HighlightCandidate,
  LlmProvider,
  TranscriptionProvider,
  TranscriptionResult,
  TranscriptSegment,
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
}
