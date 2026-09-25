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

  it("accepts a planned parse: plan + per-frame role/gutter/echo (EPISODE_STUDIO §6)", () => {
    const parse = DraftParseSchema.parse({
      plan: {
        structure: "detonate",
        archetype: "rain-soaked neon night, mirrors everywhere",
        strategy: "villain POV — Batman never fully seen",
        theme: "vanity",
        motif: "the cracked mirror",
        token: "Joker keeps the torn photograph",
      },
      story: "The Joker tells a story in a bar.",
      frames: [
        { prompt: "the bar, mirrored wall", role: "establish" },
        { prompt: "the tale begins", role: "develop", gutter: "action" },
        { prompt: "pressure rises", role: "escalate", gutter: "subject" },
        { prompt: "the punchline mirrors panel 1", role: "payoff", gutter: "action", echo: 0 },
      ],
    });
    expect(parse.plan?.structure).toBe("detonate");
    expect(parse.plan?.motif).toBe("the cracked mirror");
    expect(parse.frames[0]!.role).toBe("establish");
    expect(parse.frames[1]!.gutter).toBe("action");
    expect(parse.frames[3]!.echo).toBe(0);
  });

  it("keeps plan/role/gutter/echo optional — a minimal parse stays valid", () => {
    const parse = DraftParseSchema.parse({ story: "a tale", frames: [{ prompt: "a desk" }] });
    expect(parse.plan).toBeUndefined();
    expect(parse.frames[0]!.role).toBeUndefined();
    expect(parse.frames[0]!.gutter).toBeUndefined();
    expect(parse.frames[0]!.echo).toBeUndefined();
  });

  it("defaults partial plan fields; rejects unknown roles/gutters", () => {
    const plan = DraftParseSchema.parse({ plan: { theme: "vanity" } }).plan;
    expect(plan?.structure).toBe("kishotenketsu");
    expect(plan?.archetype).toBe("");
    expect(DraftFrameSchema.safeParse({ prompt: "x", role: "twist" }).success).toBe(false);
    expect(DraftFrameSchema.safeParse({ prompt: "x", gutter: "flashback" }).success).toBe(false);
  });
});
