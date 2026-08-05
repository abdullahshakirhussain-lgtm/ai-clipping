import { describe, expect, it } from "vitest";
import { StoryService } from "./services/story-service.js";

// Minimal stubs — suggestTopics only touches sourceVideos.list + the two providers.
const repos = { sourceVideos: { list: async () => [] } } as never;
const dispatcher = {} as never;
const svc = (cheap: unknown, llm: unknown) =>
  new StoryService(repos, llm as never, dispatcher, 50, cheap as never);

describe("StoryService.suggestTopics resilience", () => {
  it("uses the cheap provider's topics when it succeeds", async () => {
    const cheap = { suggestStoryTopics: async () => ["a", "b"] };
    const llm = { suggestStoryTopics: async () => ["should-not-be-used"] };
    expect(await svc(cheap, llm).suggestTopics()).toEqual(["a", "b"]);
  });

  it("falls back to the main LLM when the cheap provider fails", async () => {
    const cheap = { suggestStoryTopics: async () => { throw new Error("deepseek unreachable"); } };
    const llm = { suggestStoryTopics: async () => ["from-main-llm"] };
    expect(await svc(cheap, llm).suggestTopics()).toEqual(["from-main-llm"]);
  });

  it("returns canned fallback topics (never hangs) when every provider fails", async () => {
    const down = () => ({ suggestStoryTopics: async () => { throw new Error("down"); } });
    const topics = await svc(down(), down()).suggestTopics();
    expect(topics).toHaveLength(8);
    expect(topics.every((t) => typeof t === "string" && t.length > 0)).toBe(true);
  });
});
