import { describe, it, expect } from "vitest";
import { parseDraftReply } from "./draft.js";

describe("parseDraftReply", () => {
  it("parses a clean JSON object into a full parse", () => {
    const p = parseDraftReply(
      JSON.stringify({
        title: "Wukong",
        story: "A CEO chases immortality only to learn the empire was always his.",
        settings: "A corporate world of glass towers.",
        frames: [
          {
            prompt: "a poised executive at the head of a boardroom table",
            script: "Inner voice: I spent my life for this…",
            characters: ["Wukong"],
          },
        ],
      }),
    );
    expect(p.title).toBe("Wukong");
    expect(p.frames).toHaveLength(1);
    expect(p.frames[0]!.characters).toEqual(["Wukong"]);
    // Omitted per-frame fields default, so a partial frame is still whole.
    expect(p.frames[0]!.prompt).toContain("executive");
  });

  it("recovers JSON wrapped in markdown code fences and stray prose", () => {
    const raw =
      'Sure! Here you go:\n```json\n{"story":"a short tale","frames":[{"prompt":"a lone figure"}]}\n```\nHope that helps.';
    const p = parseDraftReply(raw);
    expect(p.story).toBe("a short tale");
    expect(p.frames[0]!.prompt).toBe("a lone figure");
    // Missing arrays default to empty, never undefined.
    expect(p.frames[0]!.characters).toEqual([]);
  });

  it("falls back to the raw text as the story when there is no JSON", () => {
    const p = parseDraftReply("frame1: a man stares at his hand.");
    expect(p.story).toBe("frame1: a man stares at his hand.");
    expect(p.frames).toEqual([]);
  });

  it("drops a sentinel 'continues': -1 (or null) instead of discarding the whole parse", () => {
    // Models write -1 to mean "no link"; the schema rejects negatives, so one bad
    // value must not fail validation for every otherwise-good frame.
    const raw = JSON.stringify({
      story: "a tale in three beats",
      frames: [
        { prompt: "the plaza", continues: -1 },
        { prompt: "the crowd", continues: null },
        { prompt: "the chase", continues: 0 },
      ],
    });
    const p = parseDraftReply(raw);
    expect(p.frames).toHaveLength(3);
    expect(p.frames[0]!.continues).toBeUndefined();
    expect(p.frames[1]!.continues).toBeUndefined();
    // A valid non-negative link survives untouched.
    expect(p.frames[2]!.continues).toBe(0);
  });
});
