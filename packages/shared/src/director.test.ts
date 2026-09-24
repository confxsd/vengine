import { describe, it, expect } from "vitest";
import { ComicProjectSchema, composeFramePrompt, moodDirective, type ComicProject } from "./comic.js";
import { emptyLibrary, type Library } from "./library.js";
import { SeriesSchema, type Series } from "./scene.js";
import {
  DirectorReplySchema,
  applyDirectorChanges,
  castIndex,
  matchCharacterIds,
  type DirectorChange,
} from "./director.js";

let idSeq = 0;
const makeId = () => `f${++idSeq}`;

function project(overrides: Record<string, unknown> = {}): ComicProject {
  return ComicProjectSchema.parse({
    id: "p1",
    name: "Test comic",
    story: "Selina questions who she is and leaves Bruce.",
    frames: [
      { id: "a", prompt: "a desk with a diary, dim light", script: "what kind of a cat am i?" },
      { id: "b", prompt: "two figures arguing in a bedroom" },
      { id: "c", prompt: "a woman at a fence with a suitcase" },
    ],
    cast: [
      { id: "sw", name: "Selina Kyle", aliases: ["selina", "catwoman"] },
      { id: "bw", name: "Bruce Wayne", aliases: ["bruce", "batman"] },
    ],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  });
}

function library(characters: Library["characters"] = []): Library {
  return { ...emptyLibrary(), characters };
}

function series(overrides: Record<string, unknown> = {}): Series {
  return SeriesSchema.parse({ id: "s1", name: "The Batman", ...overrides });
}

describe("moodDirective / composeFramePrompt", () => {
  it("emits nothing for empty mood", () => {
    expect(moodDirective(undefined)).toBe("");
    expect(moodDirective("   ")).toBe("");
  });

  it("normalizes trailing punctuation", () => {
    expect(moodDirective("wounded, withdrawing..")).toBe("Mood: wounded, withdrawing.");
  });

  it("frame mood overrides story mood, placed after camera and before palette", () => {
    const p = project({
      storyMood: "melancholic",
      style: { palette: ["#1b2a4a"], theme: "ink", model: "mock/gradient", seed: 1 },
      frames: [
        { id: "a", prompt: "desk", mood: "quietly liberated" },
        { id: "b", prompt: "argument", camera: "close-up" },
      ],
    });
    const withOverride = composeFramePrompt(p, p.frames[0]!);
    expect(withOverride).toContain("Mood: quietly liberated.");
    expect(withOverride).not.toContain("melancholic");

    const inherited = composeFramePrompt(p, p.frames[1]!);
    const moodAt = inherited.indexOf("Mood: melancholic.");
    const cameraAt = inherited.indexOf("Camera: close-up.");
    const paletteAt = inherited.indexOf("Color palette:");
    expect(moodAt).toBeGreaterThan(-1);
    expect(moodAt).toBeGreaterThan(cameraAt);
    expect(moodAt).toBeLessThan(paletteAt);
  });

  it("old projects without moods compose unchanged", () => {
    const p = project();
    const out = composeFramePrompt(p, p.frames[0]!);
    expect(out).not.toContain("Mood:");
  });
});

describe("cast matching", () => {
  it("matches by name or alias, case-insensitive, deduped", () => {
    const p = project();
    expect(matchCharacterIds(p.cast, ["selina", "SELINA", "batman"])).toEqual(["sw", "bw"]);
    expect(castIndex(p.cast).get("catwoman")).toBe("sw");
  });
});

describe("applyDirectorChanges", () => {
  it("applies updateProject fields including storyMood clear via null", () => {
    const p = project({ storyMood: "bleak" });
    const changes: DirectorChange[] = [
      { op: "updateProject", story: "new arc", storyMood: "tender, melancholic" },
    ];
    const out = applyDirectorChanges(p, library(), null, changes);
    expect(out.project.story).toBe("new arc");
    expect(out.project.storyMood).toBe("tender, melancholic");
    expect(out.log).toHaveLength(1);

    const cleared = applyDirectorChanges(out.project, library(), null, [
      { op: "updateProject", storyMood: null },
    ]);
    expect(cleared.project.storyMood).toBeUndefined();
  });

  it("updates a frame by index, maps characterNames to cast ids (null = whole cast)", () => {
    const p = project();
    const out = applyDirectorChanges(p, library(), null, [
      {
        op: "updateFrame",
        frameIndex: 1,
        prompt: "Bruce frozen mid-gesture, hurt in his eyes",
        mood: "wounded, not contemptuous",
        characterNames: ["bruce", "selina"],
      },
    ]);
    const frame = out.project.frames[1]!;
    expect(frame.prompt).toBe("Bruce frozen mid-gesture, hurt in his eyes");
    expect(frame.mood).toBe("wounded, not contemptuous");
    expect(frame.characterIds).toEqual(["bw", "sw"]); // input order ["bruce","selina"] preserved

    const whole = applyDirectorChanges(out.project, library(), null, [
      { op: "updateFrame", frameIndex: 1, characterNames: null },
    ]);
    expect(whole.project.frames[1]!.characterIds).toBeUndefined();
  });

  it("skips out-of-range frames and unmatched names with a report", () => {
    const p = project();
    const out = applyDirectorChanges(p, library(), null, [
      { op: "updateFrame", frameIndex: 9, prompt: "x" },
      { op: "updateFrame", frameIndex: 0, characterNames: ["joker"] },
    ]);
    expect(out.project.frames[0]!.prompt).toBe("a desk with a diary, dim light");
    expect(out.skipped).toHaveLength(2);
    expect(out.log).toHaveLength(0);
  });

  it("adds, moves and deletes frames; continuation links to the removed frame are cleared", () => {
    const p = project();
    const out = applyDirectorChanges(p, library(), null, [
      { op: "addFrame", afterIndex: 0, prompt: "a hand writing in a diary", characterNames: ["selina"] },
      { op: "deleteFrame", frameIndex: 2 }, // the original frame b, shifted right by the insert
    ]);
    expect(out.project.frames.map((f) => f.prompt)).toEqual([
      "a desk with a diary, dim light",
      "a hand writing in a diary",
      "a woman at a fence with a suitcase",
    ]);
    expect(out.project.frames[1]!.characterIds).toEqual(["sw"]);

    const linked = applyDirectorChanges(p, library(), null, [
      { op: "updateFrame", frameIndex: 2, continuesFrameIndex: 0 },
    ]);
    expect(linked.project.frames[2]!.continuesFrameId).toBe("a");
    const unlinked = applyDirectorChanges(linked.project, library(), null, [
      { op: "deleteFrame", frameIndex: 0 },
    ]);
    expect(unlinked.project.frames.find((f) => f.id === "c")?.continuesFrameId).toBeUndefined();
  });

  it("upserts an existing canon character by alias and mirrors the cast entry", () => {
    const lib = library([
      {
        id: "sw",
        name: "Selina Kyle",
        aliases: ["selina"],
        refHashes: [],
        description: "",
        palette: [],
        eras: [],
        studies: [],
        tags: [],
      },
    ]);
    const s = series({ castIds: ["sw"] });
    const out = applyDirectorChanges(project(), lib, s, [
      {
        op: "upsertCharacter",
        name: "catwoman", // matches via the project cast alias
        description: "athletic, dark short hair, black wardrobe signature",
      },
    ]);
    expect(out.dirtyCharacters).toHaveLength(1);
    expect(out.dirtyCharacters[0]!.id).toBe("sw");
    expect(out.dirtyCharacters[0]!.description).toBe("athletic, dark short hair, black wardrobe signature");
    // series cast untouched (already a member)
    expect(out.series?.castIds).toEqual(["sw"]);
  });

  it("creates a new character, adds it to the cast and the series", () => {
    const s = series();
    const out = applyDirectorChanges(project(), library(), s, [
      { op: "upsertCharacter", name: "Joker", aliases: ["joker"], description: "green hair, wide grin" },
    ]);
    const created = out.dirtyCharacters[0]!;
    expect(created.name).toBe("Joker");
    expect(out.project.cast.some((c) => c.libraryId === created.id)).toBe(true);
    expect(out.series?.castIds).toContain(created.id);
  });

  it("sets an era on a canon character: creates the era, pins the cast entry", () => {
    const hash = "a".repeat(64);
    const lib = library([
      {
        id: "bw",
        name: "Bruce Wayne",
        aliases: ["bruce"],
        refHashes: [hash],
        description: "",
        palette: [],
        eras: [],
        studies: [],
        tags: [],
      },
    ]);
    const p = project({
      cast: [{ id: "bw", name: "Bruce Wayne", aliases: ["bruce", "batman"], refHashes: [hash], libraryId: "bw" }],
    });
    const out = applyDirectorChanges(p, lib, null, [
      {
        op: "setCharacterEra",
        name: "batman", // resolves via the cast alias → libraryId
        era: "teen",
        description: "late teens, lean, soft face, no facial hair, dark untidy hair",
      },
    ]);
    // Era recorded on the canon character (with description), marked dirty.
    const canon = out.dirtyCharacters[0]!;
    expect(canon.id).toBe("bw");
    expect(canon.eras).toHaveLength(1);
    expect(canon.eras[0]!.label).toBe("teen");
    expect(canon.eras[0]!.description).toContain("late teens");
    expect(out.library.characters.find((c) => c.id === "bw")?.eras).toHaveLength(1);
    // Cast entry pinned; era has no refs yet → keeps the base refs.
    const entry = out.project.cast.find((c) => c.libraryId === "bw")!;
    expect(entry.eraLabel).toBe("teen");
    expect(entry.refHashes).toEqual([hash]);

    // Pinning again with the same label (case-insensitive) never duplicates the era.
    const again = applyDirectorChanges(out.project, out.library, null, [
      { op: "setCharacterEra", name: "Bruce Wayne", era: "Teen" },
    ]);
    expect(again.dirtyCharacters[0]!.eras).toHaveLength(1);
  });

  it("era with refs replaces the cast entry's identity refs", () => {
    const baseHash = "a".repeat(64);
    const eraHash = "b".repeat(64);
    const lib = library([
      {
        id: "bw",
        name: "Bruce Wayne",
        aliases: ["bruce"],
        refHashes: [baseHash],
        description: "",
        palette: [],
        eras: [
          { id: "e1", label: "teen", description: "", refHashes: [eraHash], palette: [] },
        ],
        studies: [],
        tags: [],
      },
    ]);
    const p = project({
      cast: [{ id: "bw", name: "Bruce Wayne", aliases: ["bruce"], refHashes: [baseHash], libraryId: "bw" }],
    });
    const out = applyDirectorChanges(p, lib, null, [
      { op: "setCharacterEra", name: "bruce", era: "teen" },
    ]);
    const entry = out.project.cast.find((c) => c.libraryId === "bw")!;
    expect(entry.eraLabel).toBe("teen");
    expect(entry.refHashes).toEqual([eraHash]);
  });

  it("setCharacterEra on an unknown character is skipped, not fatal", () => {
    const out = applyDirectorChanges(project(), library(), null, [
      { op: "setCharacterEra", name: "Alfred", era: "old" },
    ]);
    expect(out.skipped).toEqual([`no character “Alfred” to set an era on`]);
    expect(out.log).toHaveLength(0);
  });

  it("updates the series concept and reports it in the library", () => {
    const s = series({ concept: "old" });
    const lib = library();
    const out = applyDirectorChanges(project(), { ...lib, series: [s] }, s, [
      { op: "updateSeries", concept: "roles arriving before the self" },
    ]);
    expect(out.series?.concept).toBe("roles arriving before the self");
    expect(out.library.series[0]!.concept).toBe("roles arriving before the self");
  });

  it("series ops on a standalone episode are skipped, not fatal", () => {
    const out = applyDirectorChanges(project(), library(), null, [
      { op: "updateSeries", concept: "x" },
    ]);
    expect(out.skipped).toEqual(["this episode doesn't belong to a universe"]);
  });
});

describe("DirectorReplySchema", () => {
  it("parses a model reply leniently via defaults", () => {
    const reply = DirectorReplySchema.parse({ reply: "discuss", changes: [] });
    expect(reply.changes).toEqual([]);
  });

  it("validates the change union", () => {
    const reply = DirectorReplySchema.parse({
      reply: "",
      changes: [{ op: "moveFrame", from: 0, to: 2 }],
    });
    expect(reply.changes[0]).toEqual({ op: "moveFrame", from: 0, to: 2 });
    expect(DirectorReplySchema.safeParse({ changes: [{ op: "nope" }] }).success).toBe(false);
  });
});
