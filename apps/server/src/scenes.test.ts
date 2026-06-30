import { describe, it, expect } from "vitest";
import { parseBreakdown } from "./scenes.js";

describe("parseBreakdown", () => {
  it("parses a clean JSON object into a full breakdown", () => {
    const b = parseBreakdown(
      JSON.stringify({
        caption: "a rabbit sage on a cliff",
        subjects: ["a rabbit in robes"],
        setting: "a misty mountain",
        palette: ["#1b2a4a", "#c9a227"],
        mood: "contemplative",
      }),
    );
    expect(b.caption).toBe("a rabbit sage on a cliff");
    expect(b.subjects).toEqual(["a rabbit in robes"]);
    expect(b.palette).toEqual(["#1b2a4a", "#c9a227"]);
    // Omitted fields default to empty, not undefined — the breakdown is always whole.
    expect(b.lighting).toBe("");
    expect(b.styleNotes).toBe("");
  });

  it("recovers JSON wrapped in markdown code fences and stray prose", () => {
    const raw = 'Sure! Here is the description:\n```json\n{"caption":"a quiet street","mood":"calm"}\n```\nHope that helps.';
    const b = parseBreakdown(raw);
    expect(b.caption).toBe("a quiet street");
    expect(b.mood).toBe("calm");
  });

  it("falls back to the raw text as the caption when there is no JSON", () => {
    const b = parseBreakdown("A lone figure under a streetlamp at night.");
    expect(b.caption).toBe("A lone figure under a streetlamp at night.");
    expect(b.subjects).toEqual([]);
  });
});
