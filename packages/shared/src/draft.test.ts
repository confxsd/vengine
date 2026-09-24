import { describe, it, expect } from "vitest";
import { DraftFrameSchema, DraftParseSchema } from "./draft.js";

/** Draft-import schema: the storyline/mood/palette/continuity contract the parse
 *  model emits and both apply paths (new episode / add to current) consume. */
describe("DraftParseSchema", () => {
  it("defaults every new field so a minimal parse stays valid", () => {
    const parse = DraftParseSchema.parse({
      story: "Selina questions who she is and leaves Bruce.",
      frames: [{ prompt: "a desk with a diary, dim light" }],
    });
    expect(parse.storyMood).toBe("");
    expect(parse.frames[0]!.thread).toBe("");
    expect(parse.frames[0]!.mood).toBe("");
    expect(parse.frames[0]!.palette).toEqual([]);
    expect(parse.frames[0]!.continues).toBeUndefined();
  });

  it("accepts a full interleaved-storyline parse", () => {
    const parse = DraftParseSchema.parse({
      title: "The joke",
      story: "The Joker tells Batman a story in a bar.",
      storyMood: "uneasy, hypnotic",
      settings: "a dank bar, late",
      frames: [
        {
          prompt: "the Joker leans over the table, mid-tale",
          script: "Joker: let me tell you a story…",
          characters: ["Joker", "Batman"],
          thread: "framing story",
          mood: "smug, theatrical",
          palette: ["#2a4d2a", "sickly green", "bruise purple"],
        },
        {
          prompt: "a young couple walks through a sunlit park",
          script: "Selina: let's have our fortune told…",
          characters: ["Selina", "Bruce"],
          thread: "the told tale",
          mood: "tender, sun-warm",
          palette: ["warm dusk", "#e8c79a"],
          continues: 0,
        },
        {
          prompt: "the fortune teller's candlelit tent",
          characters: ["Selina", "Bruce", "Fortune teller"],
          thread: "the told tale",
          continues: 1,
        },
        {
          prompt: "the Joker throws his head back laughing",
          characters: ["Joker", "Batman"],
          thread: "framing story",
          continues: 0,
        },
      ],
    });
    expect(parse.frames).toHaveLength(4);
    // The non-adjacent continuity link is the point: frame 4 continues frame 1.
    expect(parse.frames[3]!.continues).toBe(0);
    expect(parse.frames[1]!.thread).toBe("the told tale");
  });

  it("rejects a negative or fractional continuation index", () => {
    expect(DraftFrameSchema.safeParse({ prompt: "x", continues: -1 }).success).toBe(false);
    expect(DraftFrameSchema.safeParse({ prompt: "x", continues: 1.5 }).success).toBe(false);
  });
});
