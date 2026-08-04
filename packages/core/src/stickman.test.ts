import { describe, it, expect } from "vitest";
import { stickmanSvg, POSE_NAMES } from "@clipfactory/media";

describe("stickman figure (deterministic, code-drawn)", () => {
  it("is byte-identical for identical input", () => {
    const input = { figures: [{ pose: "stand" as const, expression: "happy" as const }], width: 200, height: 200 };
    expect(stickmanSvg(input)).toBe(stickmanSvg(input));
  });

  it("renders every pose as a valid svg without throwing", () => {
    for (const pose of POSE_NAMES) {
      const svg = stickmanSvg({ figures: [{ pose }], width: 100, height: 150 });
      expect(svg.startsWith("<svg")).toBe(true);
      expect(svg.trimEnd().endsWith("</svg>")).toBe(true);
    }
  });

  it("line mode paints a white background; colour mode stays transparent", () => {
    const dims = { width: 100, height: 100 };
    const line = stickmanSvg({ figures: [{ pose: "stand" as const }], ...dims }, "line");
    const colour = stickmanSvg({ figures: [{ pose: "stand" as const }], ...dims }, "colour");
    expect(line).toContain(`<rect width="100" height="100" fill="#ffffff"`);
    expect(colour).not.toContain(`<rect width="100" height="100" fill="#ffffff"`);
  });

  it("places one <g> per figure (multi-character shots)", () => {
    const svg = stickmanSvg(
      { figures: [{ pose: "stand" as const, headItem: "crown" as const, x: 0.3 }, { pose: "point" as const, x: 0.7, flip: true }], width: 300, height: 200 },
      "colour",
    );
    expect((svg.match(/<g transform=/g) ?? []).length).toBe(2);
  });
});
