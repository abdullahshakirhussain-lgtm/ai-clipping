/** Smoke-test the DeepSeek provider: suggestions + the tight image-prompt pass. */
import { DeepSeekProvider } from "@clipfactory/ai";

const apiKey = process.env.DEEPSEEK_API_KEY!;
const model = process.env.DEEPSEEK_MODEL || "deepseek-chat";

async function main() {
  const ds = new DeepSeekProvider({ apiKey, model });

  console.log(`=== model: ${model} ===\n`);

  console.log("suggestStoryTopics (mix mainstream+niche, plain wording):");
  const topics = await ds.suggestStoryTopics({ count: 8, avoid: ["A day in the life of a Roman soldier"] });
  topics.forEach((t, i) => console.log(`  ${i + 1}. ${t}`));

  console.log("\nrefineImagePrompts (tight, on-topic, consistent character):");
  const beats = [
    { text: "It's a cold morning in a medieval village. You are Aldith, a baker, lighting your brick oven before dawn." },
    { text: "You knead the dough on a worn wooden table while the fire builds behind you." },
    { text: "By sunrise, the whole village lines up outside your door for warm loaves." },
    { text: "You trade three loaves for a basket of eggs from a neighbour." },
  ];
  const prompts = await ds.refineImagePrompts({
    topic: "what a medieval baker's day was like",
    setting: "a small medieval European village: timber-and-daub houses, a stone-and-brick bread oven, wooden tables, clay pots, muddy lanes",
    style: "stick-openai",
    beats,
  });
  prompts.forEach((p, i) => console.log(`  ${i + 1}. ${p}`));
}

main().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
