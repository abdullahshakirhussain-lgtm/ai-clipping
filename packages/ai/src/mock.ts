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

/** Deterministic highlight/enhancement generation for offline dev. */
export class MockLlmProvider implements LlmProvider {
  async detectHighlights(input: DetectHighlightsInput): Promise<HighlightCandidate[]> {
    const max = input.maxCandidates ?? 4;
    const rules = (input.rules ?? {}) as { minDurationSec?: number; maxDurationSec?: number };
    const minLen = rules.minDurationSec ?? 15;
    const maxLen = rules.maxDurationSec ?? 45;
    const seed = hash(JSON.stringify(input.segments.slice(0, 2)));
    const candidates: HighlightCandidate[] = [];
    const usable = Math.max(input.durationSec - maxLen, minLen);
    for (let i = 0; i < max; i++) {
      const start = Math.round(((seed % 97) + i * (usable / max)) % usable);
      const len = minLen + ((seed + i * 13) % (maxLen - minLen));
      const end = Math.min(start + len, input.durationSec);
      if (end - start < minLen) continue;
      const nearSeg = input.segments.find((s) => s.start >= start) ?? input.segments[0];
      candidates.push({
        startSec: start,
        endSec: end,
        hook: nearSeg ? nearSeg.text.slice(0, 80) : "You won't believe what happens next",
        reason: "Mock detector: self-contained moment with a strong opening line",
        topic: ["startups", "money", "mindset", "growth"][(seed + i) % 4]!,
      });
    }
    return candidates;
  }

  async enhanceClip(input: EnhanceClipInput): Promise<EnhancementResult> {
    const seed = hash(input.hook + input.transcriptExcerpt.slice(0, 50));
    return {
      title: `${input.hook.replace(/[.!?]+$/, "").slice(0, 60)}`,
      description: `${input.hook} — full breakdown in this clip. Follow for more ${input.topic} content.`,
      hashtags: ["#" + input.topic, "#viral", "#clips", "#fyp", "#shorts"].slice(0, 5),
      hookVariants: [
        input.hook,
        `POV: ${input.hook.charAt(0).toLowerCase()}${input.hook.slice(1)}`,
        `The truth about ${input.topic} nobody says out loud`,
      ],
      qualityScore: 55 + (seed % 40),
      viralScore: 45 + ((seed >> 3) % 50),
      estimatedEngagement: 3 + ((seed >> 6) % 70) / 10,
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
