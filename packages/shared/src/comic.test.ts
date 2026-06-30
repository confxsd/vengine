import { describe, it, expect } from "vitest";
import { builtinStylePacks } from "./library.js";
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
  referenceDirective,
  paletteDirective,
  identityReferences,
  styleReferences,
  MAX_REFS_PER_CHARACTER,
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

  it("appends a palette directive when the style has a fixed palette", () => {
    const p = project({
      style: { theme: "oil painting", model: "mock/gradient", seed: 1, palette: ["#556B2F", "warm sepia"] },
    });
    const out = composeFramePrompt(p, p.frames[0]!);
    expect(out).toContain(paletteDirective(["#556B2F", "warm sepia"]));
    expect(out).toContain("#556B2F, warm sepia");
    expect(out).toMatch(/limited palette/i);
  });

  it("emits nothing for an empty or whitespace-only palette (no dangling directive)", () => {
    const none = project();
    expect(composeFramePrompt(none, none.frames[0]!)).not.toMatch(/Color palette:/);
    expect(paletteDirective([])).toBe("");
    expect(paletteDirective(["  ", ""])).toBe("");
    const blank = project({
      style: { theme: "noir", model: "mock/gradient", seed: 1, palette: ["  ", ""] },
    });
    expect(composeFramePrompt(blank, blank.frames[0]!)).not.toMatch(/Color palette:/);
  });

  it("places the palette before the reference directive on a referenced frame", () => {
    const p = project({
      style: {
        theme: "oil",
        model: "fal/nano-banana-pro",
        seed: 1,
        palette: ["#123456"],
        anchors: [{ hash: "a".repeat(64), weight: 1 }],
      },
    });
    const out = composeFramePrompt(p, p.frames[0]!);
    const paletteAt = out.indexOf("Color palette:");
    const refAt = out.indexOf(referenceDirective("compose"));
    expect(paletteAt).toBeGreaterThan(-1);
    expect(refAt).toBeGreaterThan(-1);
    expect(paletteAt).toBeLessThan(refAt);
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
    expect(out).toMatch(/new composition/i);
    // Restage must forbid the "repaint the existing figure" failure so a newly named
    // character is added as its own figure, not swapped in place of the prior one.
    expect(continuityDirective("restage").toLowerCase()).toContain("do not simply repaint");
    expect(continuityDirective("shot")).not.toMatch(/new composition/i);
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
    expect(out).not.toMatch(/new composition/i);
  });

  it("a continuation frame with cast refs sources identity from the sheets, not the prior panel", () => {
    const sourceImg = "d".repeat(64);
    const hero = "c".repeat(64);
    const p = project({
      cast: [{ id: "hero", name: "Hero", refHashes: [hero] }],
      frames: [
        { id: "a", prompt: "the plaza", resultHash: sourceImg },
        { id: "b", prompt: "the crowd scatters", continuesFrameId: "a" }, // restage + cast refs
      ],
    });
    const out = composeFramePrompt(p, p.frames[1]!);
    // Identity-aware variant: names the extra images as character sheets and stops
    // taking likeness from the previous panel.
    expect(out).toContain(continuityDirective("restage", true));
    expect(out).toMatch(/character and style reference sheets/i);
    expect(out).toMatch(/NOT as the source of any character's likeness/i);
    // The previous panel still governs composition (restage), so this stays.
    expect(out).toMatch(/new composition/i);
    // Without cast refs the wording is the plain continuity directive (unchanged).
    const plain = project({
      frames: [
        { id: "a", prompt: "the plaza", resultHash: sourceImg },
        { id: "b", prompt: "the crowd scatters", continuesFrameId: "a" },
      ],
    });
    expect(composeFramePrompt(plain, plain.frames[1]!)).toContain(continuityDirective("restage"));
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

  it("merges cast character refs (full weight) before weighted style anchors, deduped", () => {
    const anchor = "a".repeat(64);
    const hero = "b".repeat(64);
    const villain = "c".repeat(64);
    const p = project({
      style: { ...project().style, anchors: [{ hash: anchor, weight: 0.8 }] },
      cast: [
        { id: "hero", name: "Hero", refHashes: [hero, anchor] }, // anchor reused → dedupe keeps the cast lead (full weight)
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
      { hash: hero, weight: 1 },
      { hash: anchor, weight: 1 },
      { hash: villain, weight: 1 },
    ]);
    expect(g.nodes.find((n) => n.id === genNodeId("b"))!.params.references).toEqual([
      { hash: hero, weight: 1 },
      { hash: anchor, weight: 1 },
    ]);
  });

  it("includes per-frame refHashes after continuity, then cast, then style (deduped)", () => {
    const anchor = "a".repeat(64);
    const frameRef = "b".repeat(64);
    const hero = "c".repeat(64);
    const p = project({
      style: { ...project().style, anchors: [{ hash: anchor, weight: 0.8 }] },
      cast: [{ id: "hero", name: "Hero", refHashes: [hero] }],
      frames: [{ id: "a", prompt: "the scene", refHashes: [frameRef] }],
    });
    expect(frameReferences(p, p.frames[0]!)).toEqual([
      { hash: frameRef, weight: 1 }, // per-frame ref leads (no continuity here)
      { hash: hero, weight: 1 }, // cast outranks style so likeness survives truncation
      { hash: anchor, weight: 0.8 },
    ]);
    // A frame ref also used as a style anchor dedupes to its first (frame) position.
    const shared = project({
      style: { ...project().style, anchors: [{ hash: frameRef, weight: 0.3 }] },
      frames: [{ id: "a", prompt: "x", refHashes: [frameRef] }],
    });
    expect(frameReferences(shared, shared.frames[0]!)).toEqual([{ hash: frameRef, weight: 1 }]);
  });

  it("only attaches a frame's refHashes to that frame, not its siblings", () => {
    const frameRef = "b".repeat(64);
    const p = project({
      frames: [
        { id: "a", prompt: "lead", refHashes: [frameRef] },
        { id: "b", prompt: "other" },
      ],
    });
    expect(frameReferences(p, p.frames[0]!)).toEqual([{ hash: frameRef, weight: 1 }]);
    expect(frameReferences(p, p.frames[1]!)).toEqual([]); // sibling untouched
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

describe("reference mode (composition vs identity)", () => {
  const anchor = "a".repeat(64);

  it("appends the 'compose' directive by default when identity refs are fed", () => {
    const p = project({ style: { ...project().style, anchors: [{ hash: anchor, weight: 1 }] } });
    const out = composeFramePrompt(p, p.frames[0]!);
    expect(out).toContain(referenceDirective("compose"));
    // The default directive must forbid copying the reference's composition/camera.
    expect(referenceDirective("compose").toLowerCase()).toContain("do not copy");
    expect(out).toContain("a lone figure under a flickering streetlight"); // frame prompt still leads
  });

  it("switches to the 'match' directive when the frame opts in", () => {
    const p = project({
      style: { ...project().style, anchors: [{ hash: anchor, weight: 1 }] },
      frames: [{ id: "a", prompt: "x", referenceMode: "match" }],
    });
    const out = composeFramePrompt(p, p.frames[0]!);
    expect(out).toContain(referenceDirective("match"));
    expect(out).not.toContain(referenceDirective("compose"));
    expect(referenceDirective("match")).not.toBe(referenceDirective("compose"));
  });

  it("emits NO reference directive when the frame feeds no identity references", () => {
    const p = project(); // no anchors, no cast, no per-frame refs
    const out = composeFramePrompt(p, p.frames[0]!);
    expect(out).not.toContain(referenceDirective("compose"));
    expect(out).not.toContain(referenceDirective("match"));
  });

  it("continuity governs composition and folds identity guidance in (no standalone reference directive)", () => {
    const img = "f".repeat(64);
    const p = project({
      style: { ...project().style, anchors: [{ hash: anchor, weight: 1 }] },
      frames: [
        { id: "a", prompt: "establishing", resultHash: img, variants: [{ hash: img, seed: 1 }] },
        { id: "b", prompt: "the action moves on", continuesFrameId: "a" },
      ],
    });
    const out = composeFramePrompt(p, p.frames[1]!);
    // The anchor is an identity ref, so the continuity directive carries identity guidance...
    expect(out).toContain(continuityDirective("restage", true));
    // ...rather than a second, standalone reference directive (composition stays single-governed).
    expect(out).not.toContain(referenceDirective("compose"));
  });

  it("identityReferences excludes continuity but keeps own refs → cast → style", () => {
    const own = "b".repeat(64);
    const hero = "c".repeat(64);
    const p = project({
      style: { ...project().style, anchors: [{ hash: anchor, weight: 0.5 }] },
      cast: [{ id: "hero", name: "Hero", refHashes: [hero] }],
      frames: [{ id: "a", prompt: "x", refHashes: [own] }],
    });
    expect(identityReferences(p, p.frames[0]!)).toEqual([
      { hash: own, weight: 1 },
      { hash: hero, weight: 1 },
      { hash: anchor, weight: 0.5 },
    ]);
  });

  it("caps a character's contribution at MAX_REFS_PER_CHARACTER (big sheet can't dominate)", () => {
    // A character sheet auto-split into 4 crops should only feed its first two.
    const sheet = Array.from({ length: 4 }, (_, i) => i.toString(16).repeat(64).slice(0, 64));
    const p = project({
      cast: [{ id: "bunny", name: "Bunny", refHashes: sheet }],
      frames: [{ id: "a", prompt: "x" }],
    });
    const refs = identityReferences(p, p.frames[0]!);
    expect(refs).toHaveLength(MAX_REFS_PER_CHARACTER);
    expect(refs.map((r) => r.hash)).toEqual(sheet.slice(0, MAX_REFS_PER_CHARACTER)); // strongest-first
    // Two characters each keep their own slots — no character is starved by another.
    const two = project({
      cast: [
        { id: "bunny", name: "Bunny", refHashes: sheet },
        { id: "phil", name: "Phil", refHashes: ["e".repeat(64), "f".repeat(64)] },
      ],
      frames: [{ id: "a", prompt: "x" }],
    });
    expect(identityReferences(two, two.frames[0]!)).toHaveLength(2 * MAX_REFS_PER_CHARACTER);
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

  it("leads the reference set with the base, then active cast + style (deduped)", () => {
    const anchor = "a".repeat(64);
    const hero = "b".repeat(64);
    const p = project({
      style: { ...project().style, anchors: [{ hash: anchor, weight: 0.7 }] },
      cast: [{ id: "hero", name: "Hero", refHashes: [hero] }],
    });
    const refs = editReferences(p, p.frames[0]!, base, true);
    expect(refs).toEqual([
      { hash: base, weight: 1 },
      { hash: hero, weight: 1 },
      { hash: anchor, weight: 0.7 },
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

describe("character LoRA on the cast (identity × style compose)", () => {
  const styleLora = { path: "https://w/style.safetensors", scale: 0.9, name: "Oil" };
  const yueLora = { path: "https://w/yue.safetensors", scale: 1, name: "Yue" };
  const boyLora = { path: "https://w/boy.safetensors", scale: 1, name: "Boy" };

  function castProject(overrides: Record<string, unknown> = {}) {
    return project({
      style: { ...project().style, loras: [styleLora] },
      cast: [
        { id: "yue", name: "Yue", refHashes: [], loraPath: yueLora.path, loraName: "Yue" },
        { id: "boy", name: "Boy", refHashes: [], loraPath: boyLora.path, loraName: "Boy" },
      ],
      frames: [
        { id: "a", prompt: "both" }, // whole cast (characterIds undefined)
        { id: "b", prompt: "just yue", characterIds: ["yue"] },
        { id: "c", prompt: "no one", characterIds: [] },
      ],
      ...overrides,
    });
  }

  const lorasOf = (g: ReturnType<typeof compileComic>, id: string) =>
    (g.nodes.find((n) => n.id === genNodeId(id))!.params.loras as Array<{ path: string }>).map((l) => l.path);

  it("applies a character LoRA only on frames where that character appears", () => {
    const g = compileComic(castProject());
    // Frame a: style + both characters; b: style + yue only; c: style only.
    expect(lorasOf(g, "a")).toEqual([styleLora.path, yueLora.path, boyLora.path]);
    expect(lorasOf(g, "b")).toEqual([styleLora.path, yueLora.path]);
    expect(lorasOf(g, "c")).toEqual([styleLora.path]);
  });

  it("style LoRA leads, character LoRAs follow, deduped by path", () => {
    // A character that reuses the style LoRA path must not double it.
    const g = compileComic(
      castProject({
        cast: [{ id: "yue", name: "Yue", loraPath: styleLora.path }],
        frames: [{ id: "a", prompt: "x" }],
      }),
    );
    expect(lorasOf(g, "a")).toEqual([styleLora.path]); // deduped, not [style, style]
  });

  it("a refs-only character contributes no LoRA", () => {
    const g = compileComic(
      castProject({
        style: { ...project().style, loras: [] },
        cast: [{ id: "yue", name: "Yue", refHashes: ["a".repeat(64)] }],
        frames: [{ id: "a", prompt: "x" }],
      }),
    );
    expect(g.nodes.find((n) => n.id === genNodeId("a"))!.params.loras).toBeUndefined();
  });
});

describe("built-in style packs (comic decoupling)", () => {
  it("ship distinct presets, each with its OWN negative", () => {
    const packs = builtinStylePacks();
    const ids = packs.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length); // unique ids (safe re-seed)
    expect(packs.every((p) => p.builtIn)).toBe(true);
    const comic = packs.find((p) => p.id === "builtin-comic")!;
    const oil = packs.find((p) => p.id === "builtin-oil")!;
    // The comic negative bans marks/borders/text; the oil pack must NOT inherit those
    // (a painterly look shouldn't carry "no panel border / no marks").
    expect(comic.negative).toMatch(/panel|border|speech bubble/);
    expect(oil.negative).not.toMatch(/panel|border|speech bubble|watermark/);
    expect(oil.negative).not.toBe(comic.negative);
  });
});
