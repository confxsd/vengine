import { describe, it, expect } from "vitest";
import {
  ComicProjectSchema,
  compileComic,
  compileEditFrame,
  composeFramePrompt,
  composeEditPrompt,
  editReferences,
  editDirective,
  genNodeId,
  exportNodeId,
  frameIdFromNodeId,
  unionVariants,
  frameReferenceHashes,
  frameReferences,
  continuityDirective,
  styleReferences,
  MAX_VARIANTS,
  DEFAULT_NEGATIVE,
  DEFAULT_WIDTH,
  DEFAULT_HEIGHT,
  type ComicProject,
} from "./comic.js";

// Loose param so tests can pass partial style/frame literals; the schema fills
// defaults and validates at parse time.
function project(overrides: Record<string, unknown> = {}): ComicProject {
  return ComicProjectSchema.parse({
    id: "p1",
    name: "Test comic",
    settings: "a rain-soaked neon city at night",
    style: { theme: "muted ink wash, heavy grain, cinematic", model: "mock/gradient", seed: 7 },
    frames: [
      { id: "a", prompt: "a lone figure under a flickering streetlight" },
      { id: "b", prompt: "the figure descends a flooded subway stair", seed: 99 },
    ],
    createdAt: "2026-06-28T00:00:00.000Z",
    updatedAt: "2026-06-28T00:00:00.000Z",
    ...overrides,
  });
}

describe("composeFramePrompt", () => {
  it("substitutes tokens deterministically", () => {
    const p = project();
    const out = composeFramePrompt(p, p.frames[0]!);
    expect(out).toContain("a lone figure under a flickering streetlight");
    expect(out).toContain("Setting: a rain-soaked neon city at night");
    expect(out).toContain("Style: muted ink wash, heavy grain, cinematic");
  });

  it("supports an opt-in {story} token", () => {
    const p = project({ story: "a detective chases a ghost signal", promptTemplate: "{frame}. {story}" });
    expect(composeFramePrompt(p, p.frames[0]!)).toBe(
      "a lone figure under a flickering streetlight. a detective chases a ghost signal",
    );
  });

  it("drops dangling labels when a token is empty (no 'Setting:' with no value)", () => {
    const p = project({ settings: "", style: { theme: "", model: "mock/gradient", seed: 1 } });
    const out = composeFramePrompt(p, p.frames[0]!);
    expect(out).toBe("a lone figure under a flickering streetlight");
    expect(out).not.toMatch(/Setting:|Style:/);
  });

  it("keeps the section that is present when only one token is empty", () => {
    const p = project({ settings: "", style: { theme: "noir ink", model: "mock/gradient", seed: 1 } });
    const out = composeFramePrompt(p, p.frames[0]!);
    expect(out).toContain("Style: noir ink");
    expect(out).not.toMatch(/Setting:/);
    expect(out).not.toMatch(/\n{3,}/);
  });

  it("appends the re-stage continuity directive by default for a continued frame", () => {
    const sourceImg = "d".repeat(64);
    const p = project({
      frames: [
        { id: "a", prompt: "a wide shot of the plaza", resultHash: sourceImg },
        { id: "b", prompt: "the crowd scatters", continuesFrameId: "a" }, // no mode → restage
      ],
    });
    const out = composeFramePrompt(p, p.frames[1]!);
    expect(out).toContain("the crowd scatters"); // the frame's own description still leads
    expect(out).toContain(continuityDirective("restage"));
    expect(out).toMatch(/RE-STAGE/);
  });

  it("uses the same-shot directive when the frame's mode is 'shot'", () => {
    const sourceImg = "d".repeat(64);
    const p = project({
      frames: [
        { id: "a", prompt: "a wide shot of the plaza", resultHash: sourceImg },
        { id: "b", prompt: "now in close-up", continuesFrameId: "a", continuesMode: "shot" },
      ],
    });
    const out = composeFramePrompt(p, p.frames[1]!);
    expect(out).toContain(continuityDirective("shot"));
    expect(out).not.toMatch(/RE-STAGE/);
  });

  it("emits no continuity directive when the link resolves to no image", () => {
    const dangling = project({
      frames: [
        { id: "a", prompt: "not generated yet" }, // no image to continue from
        { id: "b", prompt: "y", continuesFrameId: "a" },
      ],
    });
    expect(composeFramePrompt(dangling, dangling.frames[1]!)).not.toMatch(/Continuity:/);
    // A frame with no continuation link is likewise untouched.
    const plain = project();
    expect(composeFramePrompt(plain, plain.frames[0]!)).not.toMatch(/Continuity:/);
  });
});

describe("unionVariants", () => {
  it("dedups by hash and keeps most-recent-last", () => {
    const a = { hash: "a".repeat(64), seed: 1 };
    const b = { hash: "b".repeat(64), seed: 2 };
    const bNewSeed = { hash: "b".repeat(64), seed: 9 };
    expect(unionVariants([a, b], [bNewSeed])).toEqual([a, bNewSeed]); // incoming seed wins, no dupe
  });

  it("caps the history at MAX_VARIANTS", () => {
    const existing = Array.from({ length: MAX_VARIANTS }, (_, i) => ({
      hash: i.toString(16).padStart(64, "0"),
      seed: i,
    }));
    const fresh = { hash: "f".repeat(64), seed: 99 };
    const merged = unionVariants(existing, [fresh]);
    expect(merged).toHaveLength(MAX_VARIANTS);
    expect(merged.at(-1)).toEqual(fresh); // newest retained
    expect(merged[0]).toEqual(existing[1]); // oldest evicted
  });

  it("handles undefined inputs", () => {
    expect(unionVariants(undefined, undefined)).toEqual([]);
  });
});

describe("compileComic", () => {
  it("emits a gen+export pair per frame with frame-id-based ids", () => {
    const p = project();
    const g = compileComic(p);
    expect(g.nodes).toHaveLength(4);
    expect(g.edges).toHaveLength(2);
    expect(g.nodes.map((n) => n.id).sort()).toEqual(
      [genNodeId("a"), genNodeId("b"), exportNodeId("a"), exportNodeId("b")].sort(),
    );
    // ids round-trip back to frame ids for WS/result routing.
    expect(frameIdFromNodeId(genNodeId("b"))).toBe("b");
    expect(frameIdFromNodeId(exportNodeId("a"))).toBe("a");
  });

  it("bakes composed prompt + negative into each generation node", () => {
    const g = compileComic(project());
    const gen = g.nodes.find((n) => n.id === genNodeId("a"))!;
    expect(gen.params.prompt).toContain("a lone figure under a flickering streetlight");
    expect(gen.params.negativePrompt).toBe(DEFAULT_NEGATIVE);
  });

  it("applies seed precedence: frame seed overrides style seed", () => {
    const g = compileComic(project());
    expect(g.nodes.find((n) => n.id === genNodeId("a"))!.params.seed).toBe(7); // style seed
    expect(g.nodes.find((n) => n.id === genNodeId("b"))!.params.seed).toBe(99); // frame override
  });

  it("emits weighted references only when set", () => {
    const anchor = "f".repeat(64);
    const withAnchor = compileComic(
      project({ style: { ...project().style, anchors: [{ hash: anchor, weight: 0.6 }] } }),
    );
    expect(withAnchor.nodes.find((n) => n.id === genNodeId("a"))!.params.references).toEqual([
      { hash: anchor, weight: 0.6 },
    ]);
    const without = compileComic(project());
    expect(without.nodes.find((n) => n.id === genNodeId("a"))!.params.references).toBeUndefined();
  });

  it("migrates a legacy single anchorHash into a full-weight reference", () => {
    const anchor = "e".repeat(64);
    const g = compileComic(project({ style: { ...project().style, anchorHash: anchor } }));
    expect(g.nodes.find((n) => n.id === genNodeId("a"))!.params.references).toEqual([
      { hash: anchor, weight: 1 },
    ]);
  });

  it("merges cast character refs (full weight) after weighted style anchors, deduped", () => {
    const anchor = "a".repeat(64);
    const hero = "b".repeat(64);
    const villain = "c".repeat(64);
    const p = project({
      style: { ...project().style, anchors: [{ hash: anchor, weight: 0.8 }] },
      cast: [
        { id: "hero", name: "Hero", refHashes: [hero, anchor] }, // anchor reused → must dedupe (keeps 0.8)
        { id: "villain", name: "Villain", refHashes: [villain] },
      ],
      // frame "a" has no characterIds → whole cast; frame "b" selects just the hero.
      frames: [
        { id: "a", prompt: "both meet on the bridge" },
        { id: "b", prompt: "the hero alone", characterIds: ["hero"] },
      ],
    });
    const g = compileComic(p);
    expect(g.nodes.find((n) => n.id === genNodeId("a"))!.params.references).toEqual([
      { hash: anchor, weight: 0.8 },
      { hash: hero, weight: 1 },
      { hash: villain, weight: 1 },
    ]);
    expect(g.nodes.find((n) => n.id === genNodeId("b"))!.params.references).toEqual([
      { hash: anchor, weight: 0.8 },
      { hash: hero, weight: 1 },
    ]);
  });

  it("styleReferences migrates legacy anchorHash but prefers explicit anchors", () => {
    const legacy = "a".repeat(64);
    const a = "b".repeat(64);
    expect(styleReferences(project({ style: { ...project().style, anchorHash: legacy } }).style)).toEqual(
      [{ hash: legacy, weight: 1 }],
    );
    // explicit anchors win over a stale legacy field
    const both = project({
      style: { ...project().style, anchorHash: legacy, anchors: [{ hash: a, weight: 0.5 }] },
    });
    expect(styleReferences(both.style)).toEqual([{ hash: a, weight: 0.5 }]);
    expect(frameReferences(both, both.frames[0]!)).toEqual([{ hash: a, weight: 0.5 }]);
  });

  it("treats an empty characterIds as 'no characters' (style anchor still applies)", () => {
    const anchor = "a".repeat(64);
    const hero = "b".repeat(64);
    const p = project({
      style: { ...project().style, anchorHash: anchor },
      cast: [{ id: "hero", name: "Hero", refHashes: [hero] }],
      frames: [{ id: "a", prompt: "an empty rain-soaked alley", characterIds: [] }],
    });
    expect(frameReferenceHashes(p, p.frames[0]!)).toEqual([anchor]);
  });

  it("ignores unknown character ids so removing a character never breaks a frame", () => {
    const hero = "b".repeat(64);
    const p = project({
      cast: [{ id: "hero", name: "Hero", refHashes: [hero] }],
      frames: [{ id: "a", prompt: "x", characterIds: ["hero", "ghost-deleted"] }],
    });
    expect(frameReferenceHashes(p, p.frames[0]!)).toEqual([hero]);
  });

  it("feeds the continued frame's image in as the leading, full-weight reference", () => {
    const anchor = "a".repeat(64);
    const sourceImg = "d".repeat(64);
    const p = project({
      style: { ...project().style, anchors: [{ hash: anchor, weight: 0.5 }] },
      frames: [
        { id: "a", prompt: "a wide shot of the plaza", resultHash: sourceImg },
        { id: "b", prompt: "same plaza, the crowd now scatters", continuesFrameId: "a" },
      ],
    });
    // Continuity leads (strongest), full weight, before the style anchor.
    expect(frameReferences(p, p.frames[1]!)).toEqual([
      { hash: sourceImg, weight: 1 },
      { hash: anchor, weight: 0.5 },
    ]);
    // The source frame itself has no continuation, so only the style anchor applies.
    expect(frameReferences(p, p.frames[0]!)).toEqual([{ hash: anchor, weight: 0.5 }]);
  });

  it("uses the continued frame's newest variant when no result is selected", () => {
    const v1 = "1".repeat(64);
    const v2 = "2".repeat(64);
    const p = project({
      frames: [
        { id: "a", prompt: "x", variants: [{ hash: v1, seed: 1 }, { hash: v2, seed: 2 }] },
        { id: "b", prompt: "y", continuesFrameId: "a" },
      ],
    });
    expect(frameReferenceHashes(p, p.frames[1]!)).toEqual([v2]); // newest variant
  });

  it("ignores a self-link, an unknown target, or a target with no image yet", () => {
    const self = project({ frames: [{ id: "a", prompt: "x", continuesFrameId: "a" }] });
    expect(frameReferenceHashes(self, self.frames[0]!)).toEqual([]);

    const missing = project({ frames: [{ id: "a", prompt: "x", continuesFrameId: "ghost" }] });
    expect(frameReferenceHashes(missing, missing.frames[0]!)).toEqual([]);

    const noImage = project({
      frames: [
        { id: "a", prompt: "not generated yet" },
        { id: "b", prompt: "y", continuesFrameId: "a" },
      ],
    });
    expect(frameReferenceHashes(noImage, noImage.frames[1]!)).toEqual([]);
  });

  it("dedupes when the continued image is also a style anchor (keeps its lead)", () => {
    const shared = "e".repeat(64);
    const p = project({
      style: { ...project().style, anchors: [{ hash: shared, weight: 0.3 }] },
      frames: [
        { id: "a", prompt: "x", resultHash: shared },
        { id: "b", prompt: "y", continuesFrameId: "a" },
      ],
    });
    // First occurrence wins: continuity's full weight, sent once.
    expect(frameReferences(p, p.frames[1]!)).toEqual([{ hash: shared, weight: 1 }]);
  });

  it("bakes the continuity reference into the compiled generation node", () => {
    const sourceImg = "c".repeat(64);
    const p = project({
      frames: [
        { id: "a", prompt: "establishing shot", resultHash: sourceImg },
        { id: "b", prompt: "the action continues", continuesFrameId: "a" },
      ],
    });
    const g = compileComic(p);
    expect(g.nodes.find((n) => n.id === genNodeId("b"))!.params.references).toEqual([
      { hash: sourceImg, weight: 1 },
    ]);
  });

  it("emits non-blank house-style LoRAs (path+scale only) on every frame", () => {
    const p = project({
      style: {
        ...project().style,
        loras: [
          { path: "https://h/style.safetensors", scale: 0.7, name: "My style" },
          { path: "   ", scale: 1, name: "blank — dropped" },
        ],
      },
    });
    const g = compileComic(p);
    for (const id of ["a", "b"]) {
      expect(g.nodes.find((n) => n.id === genNodeId(id))!.params.loras).toEqual([
        { path: "https://h/style.safetensors", scale: 0.7 }, // name stripped, blank row dropped
      ]);
    }
  });

  it("omits loras entirely when none are configured", () => {
    const g = compileComic(project());
    expect(g.nodes.find((n) => n.id === genNodeId("a"))!.params.loras).toBeUndefined();
  });

  it("routes export nodes to the requested dir/format", () => {
    const g = compileComic(project(), { exportDir: "/tmp/frames", format: "webp" });
    const exp = g.nodes.find((n) => n.id === exportNodeId("a"))!;
    expect(exp.params.dir).toBe("/tmp/frames");
    expect(exp.params.format).toBe("webp");
    expect(exp.params.filename).toBe("frame-1");
  });

  it("defaults to a true 9:16 vertical canvas", () => {
    const g = compileComic(project());
    const gen = g.nodes.find((n) => n.id === genNodeId("a"))!;
    expect(gen.params.width).toBe(DEFAULT_WIDTH);
    expect(gen.params.height).toBe(DEFAULT_HEIGHT);
    // 768×1344 is the SDXL/fal-friendly ~1MP portrait bucket nearest exact 9:16.
    expect(DEFAULT_WIDTH / DEFAULT_HEIGHT).toBeCloseTo(9 / 16, 1);
    expect(DEFAULT_HEIGHT).toBeGreaterThan(DEFAULT_WIDTH);
  });
});

describe("in-place edit", () => {
  const base = "d".repeat(64);

  it("composeEditPrompt leads with the instruction, then the mode directive", () => {
    const out = composeEditPrompt("she leans back, lower camera angle", "tweak");
    expect(out.startsWith("she leans back, lower camera angle")).toBe(true);
    expect(out).toContain(editDirective("tweak"));
    // tweak preserves the frame; restage frees the camera — the two must differ.
    expect(editDirective("tweak")).not.toBe(editDirective("restage"));
    expect(editDirective("restage").toLowerCase()).toContain("re-stage");
  });

  it("composeEditPrompt falls back to just the directive for an empty instruction", () => {
    expect(composeEditPrompt("   ", "restage")).toBe(editDirective("restage"));
  });

  it("leads the reference set with the base, then style + active cast (deduped)", () => {
    const anchor = "a".repeat(64);
    const hero = "b".repeat(64);
    const p = project({
      style: { ...project().style, anchors: [{ hash: anchor, weight: 0.7 }] },
      cast: [{ id: "hero", name: "Hero", refHashes: [hero] }],
    });
    const refs = editReferences(p, p.frames[0]!, base, true);
    expect(refs).toEqual([
      { hash: base, weight: 1 },
      { hash: anchor, weight: 0.7 },
      { hash: hero, weight: 1 },
    ]);
    // keepStyle=false reduces to the lone base image.
    expect(editReferences(p, p.frames[0]!, base, false)).toEqual([{ hash: base, weight: 1 }]);
  });

  it("keeps the base leading even when it is also a style ref", () => {
    const p = project({ style: { ...project().style, anchors: [{ hash: base, weight: 0.5 }] } });
    expect(editReferences(p, p.frames[0]!, base, true)).toEqual([{ hash: base, weight: 1 }]);
  });

  it("compiles a single gen node keyed by the frame id, with the base + instruction baked in", () => {
    const p = project();
    const g = compileEditFrame(p, p.frames[0]!, { baseHash: base, instruction: "warmer light" });
    expect(g.nodes).toHaveLength(1);
    expect(g.edges).toHaveLength(0);
    const gen = g.nodes[0]!;
    // Frame-id node id → live preview/progress routes to the frame like a normal run.
    expect(gen.id).toBe(genNodeId("a"));
    expect(frameIdFromNodeId(gen.id)).toBe("a");
    expect(gen.params.prompt).toContain("warmer light");
    expect(gen.params.references).toEqual([{ hash: base, weight: 1 }]);
    expect(gen.params.negativePrompt).toBe(DEFAULT_NEGATIVE);
  });

  it("applies edit seed precedence: request → frame → style seed", () => {
    const p = project(); // frame "a" has no seed (style seed 7); frame "b" seed 99
    expect(compileEditFrame(p, p.frames[0]!, { baseHash: base, instruction: "x" }).nodes[0]!.params.seed).toBe(7);
    expect(compileEditFrame(p, p.frames[1]!, { baseHash: base, instruction: "x" }).nodes[0]!.params.seed).toBe(99);
    expect(
      compileEditFrame(p, p.frames[0]!, { baseHash: base, instruction: "x", seed: 123 }).nodes[0]!.params.seed,
    ).toBe(123);
  });
});
