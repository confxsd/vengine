import { describe, it, expect } from "vitest";
import { builtinStylePacks } from "./library.js";
import {
  ComicProjectSchema,
  ComicFrameSchema,
  EpisodePlanSchema,
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
  echoReferences,
  echoDirective,
  continuityDirective,
  referenceDirective,
  paletteDirective,
  cameraDirective,
  craftDirective,
  transitionDirective,
  ROLE_FLAVORS,
  TRANSITION_DIRECTIVES,
  CRAFT_DIRECTIVE,
  artDirectionLines,
  cameraSizeOf,
  gutterReconcile,
  rhythmWarnings,
  structureRoleAt,
  STRUCTURE_ROLES,
  FRAME_ROLES,
  GUTTER_TYPES,
  GUTTER_EFFORT,
  identityReferences,
  leadRef,
  styleReferences,
  MAX_REFS_PER_CHARACTER,
  MAX_VARIANTS,
  DEFAULT_NEGATIVE,
  DEFAULT_WIDTH,
  DEFAULT_HEIGHT,
  type ComicFrame,
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
      `a lone figure under a flickering streetlight. a detective chases a ghost signal\n\n${CRAFT_DIRECTIVE}`,
    );
  });

  it("drops dangling labels when a token is empty (no 'Setting:' with no value)", () => {
    const p = project({ settings: "", style: { theme: "", model: "mock/gradient", seed: 1 } });
    const out = composeFramePrompt(p, p.frames[0]!);
    expect(out).toBe(`a lone figure under a flickering streetlight\n\n${CRAFT_DIRECTIVE}`);
    expect(out).not.toMatch(/Setting:|Style:/);
  });

  it("appends the house craft directive to every frame, after the scene, before the knobs", () => {
    const p = project({
      style: { theme: "oil", model: "mock/gradient", seed: 1, palette: ["#123456"] },
      frames: [{ id: "a", prompt: "a plaza", camera: "wide shot" }],
    });
    const out = composeFramePrompt(p, p.frames[0]!);
    expect(out).toContain(CRAFT_DIRECTIVE);
    // Art direction sits with the scene it frames; camera and palette trail it.
    const craftAt = out.indexOf(CRAFT_DIRECTIVE);
    expect(craftAt).toBeGreaterThan(out.indexOf("a plaza"));
    expect(craftAt).toBeLessThan(out.indexOf("Camera:"));
    expect(craftAt).toBeLessThan(out.indexOf("Color palette:"));
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

  it("a frame palette overrides the project palette (storyline contrast)", () => {
    const p = project({
      style: { theme: "oil painting", model: "mock/gradient", seed: 1, palette: ["#556B2F", "warm sepia"] },
      frames: [{ id: "a", prompt: "the bar", palette: ["sickly green", "#2a4d2a"] }],
    });
    const out = composeFramePrompt(p, p.frames[0]!);
    expect(out).toContain("sickly green, #2a4d2a");
    expect(out).not.toContain("#556B2F");
  });

  it("an absent frame palette inherits the project palette", () => {
    const p = project({
      style: { theme: "oil", model: "mock/gradient", seed: 1, palette: ["#123456"] },
      frames: [{ id: "a", prompt: "the plaza" }],
    });
    expect(composeFramePrompt(p, p.frames[0]!)).toContain("#123456");
  });

  it("an explicit empty frame palette drops the project palette lock for that frame", () => {
    const p = project({
      style: { theme: "oil", model: "mock/gradient", seed: 1, palette: ["#123456"] },
      frames: [{ id: "a", prompt: "the plaza", palette: [] }],
    });
    expect(composeFramePrompt(p, p.frames[0]!)).not.toMatch(/Color palette:/);
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

  it("normalises the camera directive (trailing period, whitespace)", () => {
    expect(cameraDirective(undefined)).toBe("");
    expect(cameraDirective("  ")).toBe("");
    expect(cameraDirective("close-up")).toBe("Camera: close-up.");
    // A hand-typed phrase with its own period reads identically to a preset.
    expect(cameraDirective("dutch angle.")).toBe("Camera: dutch angle.");
  });

  it("appends a camera directive when the frame sets one, after the scene", () => {
    const p = project({
      frames: [{ id: "a", prompt: "a lone figure under a flickering streetlight", camera: "low-angle shot looking up" }],
    });
    const out = composeFramePrompt(p, p.frames[0]!);
    expect(out).toContain("Camera: low-angle shot looking up.");
    // Sits after the scene text, before the setting/style block is irrelevant to order
    // here; assert it trails the subject.
    expect(out.indexOf("Camera:")).toBeGreaterThan(out.indexOf("a lone figure"));
  });

  it("emits no camera directive for an empty/whitespace or unset camera", () => {
    const none = project();
    expect(composeFramePrompt(none, none.frames[0]!)).not.toMatch(/Camera:/);
    const blank = project({ frames: [{ id: "a", prompt: "x", camera: "   " }] });
    expect(composeFramePrompt(blank, blank.frames[0]!)).not.toMatch(/Camera:/);
  });

  it("places the camera directive before the palette", () => {
    const p = project({
      style: { theme: "oil", model: "mock/gradient", seed: 1, palette: ["#123456"] },
      frames: [{ id: "a", prompt: "a plaza", camera: "wide shot" }],
    });
    const out = composeFramePrompt(p, p.frames[0]!);
    const cameraAt = out.indexOf("Camera:");
    const paletteAt = out.indexOf("Color palette:");
    expect(cameraAt).toBeGreaterThan(-1);
    expect(paletteAt).toBeGreaterThan(cameraAt);
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

  it("'match' names the FIRST image as composition source when a pose ref rides with cast/style sheets", () => {
    const pose = "d".repeat(64);
    const hero = "c".repeat(64);
    const p = project({
      style: { ...project().style, anchors: [{ hash: anchor, weight: 1 }] },
      cast: [{ id: "hero", name: "Hero", refHashes: [hero] }],
      frames: [{ id: "a", prompt: "x", refHashes: [pose], referenceMode: "match" }],
    });
    const out = composeFramePrompt(p, p.frames[0]!);
    expect(out).toContain(referenceDirective("match", true));
    expect(out).not.toContain(referenceDirective("match", false));
    // The frame's own ref leads the fed order, so "FIRST" points at the pose ref…
    expect(identityReferences(p, p.frames[0]!)[0]!.hash).toBe(pose);
    // …and the directive splits the roles: first = layout, rest = identity sheets.
    expect(referenceDirective("match", true)).toContain("FIRST attached image");
    expect(referenceDirective("match", true)).toContain("NOT from the composition reference");
  });

  it("'match' keeps the generic directive when the frame has no own layout ref", () => {
    const p = project({
      style: { ...project().style, anchors: [{ hash: anchor, weight: 1 }] },
      frames: [{ id: "a", prompt: "x", referenceMode: "match" }],
    });
    const out = composeFramePrompt(p, p.frames[0]!);
    expect(out).toContain(referenceDirective("match", false));
    expect(out).not.toContain("FIRST attached image");
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

  it("leadRef promotes a hash to the front so it lands inside the reference cap", () => {
    const a = "a".repeat(64), b = "b".repeat(64), c = "c".repeat(64);
    // A brand-new promote leads (highest weight, within the cap).
    expect(leadRef([a, b], c)).toEqual([c, a, b]);
    // Promoting an existing backup ref (index ≥ cap) moves it into the fed window
    // instead of leaving it stranded past the slice — no duplication.
    const promoted = leadRef([a, b, c], c);
    expect(promoted).toEqual([c, a, b]);
    expect(promoted.slice(0, MAX_REFS_PER_CHARACTER)).toContain(c);
    // Idempotent on the already-leading ref.
    expect(leadRef([a, b], a)).toEqual([a, b]);
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

// ---------------------------------------------------------------------------
// Episode Studio Phase 1 — planned episodes (docs/EPISODE_STUDIO.md §13)
// ---------------------------------------------------------------------------

/** The house craft sentence, verbatim — inlined (not via CRAFT_DIRECTIVE) so the
 *  golden tests below pin the exact bytes the previous release composed. */
const CRAFT_GOLDEN =
  "Craft: compose this frame like a masterwork — deliberate cinematic staging (dynamic framing, layered depth, intentional negative space), figures whose posture, gesture, hands, gaze and facial expression carry the beat's meaning, motivated lighting, and symbolic objects or environmental detail placed with intention.";

/** Minimal frame literal for the structure/reconcile/rhythm suites. */
const fr = (id: string, extra: Record<string, unknown> = {}): ComicFrame =>
  ComicFrameSchema.parse({ id, prompt: id, ...extra });

describe("episode plan schemas (no migration)", () => {
  it("an old-style project JSON parses with every new field absent", () => {
    const old = ComicProjectSchema.parse({
      id: "old",
      name: "Legacy",
      frames: [{ id: "a", prompt: "x" }],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(old.plan).toBeUndefined();
    expect(old.frames[0]!.role).toBeUndefined();
    expect(old.frames[0]!.gutter).toBeUndefined();
    expect(old.frames[0]!.echoFrameId).toBeUndefined();
  });

  it("EpisodePlanSchema defaults everything; structure slot maps are data", () => {
    const plan = EpisodePlanSchema.parse({});
    expect(plan.structure).toBe("kishotenketsu");
    expect(plan.archetype).toBe("");
    expect(STRUCTURE_ROLES.detonate).toEqual(["establish", "develop", "escalate", "payoff"]);
    expect(STRUCTURE_ROLES.kishotenketsu).toEqual(["establish", "develop", "turn", "settle"]);
    // Beyond the four slots, roles repeat develop/escalate (documented extension).
    expect(structureRoleAt("kishotenketsu", 2)).toBe("turn");
    expect(structureRoleAt("kishotenketsu", 4)).toBe("develop");
    expect(structureRoleAt("kishotenketsu", 5)).toBe("escalate");
    expect(structureRoleAt("detonate", 3)).toBe("payoff");
  });

  it("camera presets carry coarse sizes; cameraSizeOf maps value → size", () => {
    expect(cameraSizeOf(fr("a", { camera: "wide shot" }))).toBe("wide");
    expect(cameraSizeOf(fr("a", { camera: "extreme wide establishing shot" }))).toBe("xws");
    expect(cameraSizeOf(fr("a", { camera: "extreme close-up" }))).toBe("xcu");
    // Angle presets say nothing about distance — nor does free text or no camera.
    expect(cameraSizeOf(fr("a", { camera: "low-angle shot looking up" }))).toBeUndefined();
    expect(cameraSizeOf(fr("a", { camera: "dutch tilt, hand-cranked chaos" }))).toBeUndefined();
    expect(cameraSizeOf(fr("a"))).toBeUndefined();
    expect(cameraSizeOf(fr("a", { camera: "  " }))).toBeUndefined();
  });
});

describe("composeFramePrompt v2 — golden (pre-plan projects compose byte-identically)", () => {
  it("old-style project: template + craft + camera + mood + palette, exactly as v1", () => {
    const p = project({
      style: { theme: "ink", model: "mock/gradient", seed: 1, palette: ["#123456"] },
      frames: [{ id: "a", prompt: "a plaza", camera: "wide shot", mood: "quiet dread" }],
    });
    expect(composeFramePrompt(p, p.frames[0]!)).toBe(
      [
        "a plaza",
        "",
        "Setting: a rain-soaked neon city at night",
        "Style: ink",
        "",
        CRAFT_GOLDEN,
        "",
        "Camera: wide shot.",
        "",
        "Mood: quiet dread.",
        "",
        "Color palette: render using only this limited palette — #123456.",
      ].join("\n"),
    );
  });

  it("old-style continuation project: v1 order with the continuity directive trailing", () => {
    const img = "d".repeat(64);
    const p = project({
      frames: [
        { id: "a", prompt: "a wide shot of the plaza", resultHash: img },
        { id: "b", prompt: "the crowd scatters", continuesFrameId: "a" },
      ],
    });
    expect(composeFramePrompt(p, p.frames[1]!)).toBe(
      [
        "the crowd scatters",
        "",
        "Setting: a rain-soaked neon city at night",
        "Style: muted ink wash, heavy grain, cinematic",
        "",
        CRAFT_GOLDEN,
        "",
        continuityDirective("restage"),
      ].join("\n"),
    );
  });
});

describe("composeFramePrompt v2 — art direction & roles", () => {
  it("composes the plan's art-direction block after the scene, before craft", () => {
    const p = project({
      plan: {
        structure: "kishotenketsu",
        archetype: "rain-soaked neon night, mirrors everywhere",
        theme: "vanity",
        motif: "the cracked mirror",
      },
      frames: [{ id: "a", prompt: "a plaza", role: "establish" }],
    });
    const out = composeFramePrompt(p, p.frames[0]!);
    expect(out).toContain("Art direction: rain-soaked neon night, mirrors everywhere.");
    expect(out).toContain("Theme: vanity.");
    expect(out).toContain('Motif: weave "the cracked mirror" into this frame only where it earns its place.');
    const artAt = out.indexOf("Art direction:");
    expect(artAt).toBeGreaterThan(out.indexOf("a plaza")); // after the template
    expect(artAt).toBeLessThan(out.indexOf(CRAFT_DIRECTIVE)); // before craft
    // Role flavor merges into the craft paragraph, after the house sentence.
    expect(out).toContain(`${CRAFT_DIRECTIVE} ${ROLE_FLAVORS.establish}`);
  });

  it("drops art-direction lines whose value is empty; an all-empty plan emits nothing", () => {
    expect(artDirectionLines(undefined)).toEqual([]);
    expect(artDirectionLines(EpisodePlanSchema.parse({}))).toEqual([]);
    expect(artDirectionLines(EpisodePlanSchema.parse({ motif: "the cracked mirror" }))).toEqual([
      'Motif: weave "the cracked mirror" into this frame only where it earns its place.',
    ]);
    // Trailing punctuation on the values is normalised, not doubled.
    expect(artDirectionLines(EpisodePlanSchema.parse({ archetype: "neon night." }))).toEqual([
      "Art direction: neon night.",
    ]);
    const p = project({ plan: { structure: "detonate" }, frames: [{ id: "a", prompt: "x" }] });
    expect(composeFramePrompt(p, p.frames[0]!)).not.toMatch(/Art direction:|Theme:|Motif:/);
  });

  it("craftDirective: house baseline verbatim without a role; flavor appended with one", () => {
    expect(craftDirective()).toBe(CRAFT_DIRECTIVE);
    expect(craftDirective(undefined)).toBe(CRAFT_DIRECTIVE);
    for (const role of FRAME_ROLES) {
      expect(craftDirective(role)).toBe(`${CRAFT_DIRECTIVE} ${ROLE_FLAVORS[role]}`);
      expect(ROLE_FLAVORS[role].length).toBeGreaterThan(20); // every slot has teeth
    }
  });
});

describe("composeFramePrompt v2 — typed gutters", () => {
  it("emits the transition directive on entering frames, after the palette and before the composition directive", () => {
    const img = "d".repeat(64);
    const p = project({
      style: { theme: "ink", model: "mock/gradient", seed: 1, palette: ["#123456"] },
      frames: [
        { id: "a", prompt: "the plaza", resultHash: img },
        { id: "b", prompt: "later, the crowd gone", gutter: "action", continuesFrameId: "a" },
      ],
    });
    const out = composeFramePrompt(p, p.frames[1]!);
    expect(out).toContain(TRANSITION_DIRECTIVES.action);
    const transitionAt = out.indexOf("Transition:");
    expect(transitionAt).toBeGreaterThan(out.indexOf("Color palette:"));
    expect(transitionAt).toBeLessThan(out.indexOf("Continuity:"));
  });

  it("a frame without a gutter emits nothing; a stale gutter on the first frame emits nothing", () => {
    const p = project({
      frames: [
        { id: "a", prompt: "x", gutter: "action" }, // meaningless without a predecessor
        { id: "b", prompt: "y" },
      ],
    });
    expect(composeFramePrompt(p, p.frames[0]!)).not.toMatch(/Transition/);
    expect(composeFramePrompt(p, p.frames[1]!)).not.toMatch(/Transition/);
    expect(transitionDirective(undefined)).toBe("");
    // Every gutter type carries its directive (machinery, not taxonomy).
    for (const g of GUTTER_TYPES) expect(transitionDirective(g)).toBe(TRANSITION_DIRECTIVES[g]);
  });
});

describe("composeFramePrompt v2 — echo (the bookend payout)", () => {
  const echoImg = "1".repeat(64);
  const contImg = "2".repeat(64);
  const hero = "3".repeat(64);
  const anchor = "4".repeat(64);

  function echoProject() {
    return project({
      style: { theme: "ink", model: "mock/gradient", seed: 1, anchors: [{ hash: anchor, weight: 0.5 }] },
      cast: [{ id: "hero", name: "Hero", refHashes: [hero] }],
      frames: [
        { id: "a", prompt: "the opening composition", resultHash: echoImg },
        { id: "b", prompt: "the middle", resultHash: contImg },
        { id: "c", prompt: "the closing mirrors the opening", continuesFrameId: "b", echoFrameId: "a" },
      ],
    });
  }

  it("a resolved echo LEADS the reference order, ahead of continuity, cast and style (deduped)", () => {
    const p = echoProject();
    expect(frameReferences(p, p.frames[2]!)).toEqual([
      { hash: echoImg, weight: 1 },
      { hash: contImg, weight: 1 },
      { hash: hero, weight: 1 },
      { hash: anchor, weight: 0.5 },
    ]);
    expect(echoReferences(p, p.frames[2]!)).toEqual([{ hash: echoImg, weight: 1 }]);
  });

  it("a resolved echo governs composition — echo directive replaces continuity/reference", () => {
    const p = echoProject();
    const out = composeFramePrompt(p, p.frames[2]!);
    expect(out).toContain(echoDirective(true)); // cast/style sheets ride along
    expect(out).not.toMatch(/Continuity:/); // continuity no longer governs
    expect(out).not.toContain(referenceDirective("compose"));
  });

  it("echo directive wording splits composition from identity sheets only when sheets exist", () => {
    expect(echoDirective()).not.toContain("Remaining attached images");
    expect(echoDirective(true)).toContain("character and style reference sheets");
    expect(echoDirective()).toContain("FIRST attached image");
  });

  it("an unresolved echo (source has no image) emits no directive and no reference — links resolve defensively", () => {
    const p = project({
      frames: [
        { id: "a", prompt: "not generated yet" },
        { id: "b", prompt: "the closing", echoFrameId: "a" },
      ],
    });
    expect(frameReferenceHashes(p, p.frames[1]!)).toEqual([]);
    expect(composeFramePrompt(p, p.frames[1]!)).not.toMatch(/Echo:/);
  });

  it("echo + continuity both set → echo wins AND a review note fires", () => {
    const p = echoProject();
    const notes = rhythmWarnings({ frames: p.frames });
    expect(notes.some((n) => n.includes("both an echo and a continuity link"))).toBe(true);
  });
});

describe("preview == compile (single prompt code path)", () => {
  it("the compiled generation node's prompt is exactly composeFramePrompt, all v2 features on", () => {
    const img = "d".repeat(64);
    const p = project({
      plan: { structure: "detonate", archetype: "neon night", theme: "vanity", motif: "the mirror" },
      style: { theme: "ink", model: "mock/gradient", seed: 1, palette: ["#123456"] },
      cast: [{ id: "hero", name: "Hero", refHashes: ["e".repeat(64)] }],
      frames: [
        { id: "a", prompt: "opening", role: "establish", camera: "wide shot", resultHash: img },
        { id: "b", prompt: "develops", role: "develop", gutter: "action", continuesFrameId: "a" },
        { id: "c", prompt: "turns", role: "escalate", gutter: "subject", camera: "extreme close-up" },
        { id: "d", prompt: "pays off mirroring panel 1", role: "payoff", gutter: "action", echoFrameId: "a" },
      ],
    });
    const g = compileComic(p);
    for (const f of p.frames) {
      expect(g.nodes.find((n) => n.id === genNodeId(f.id))!.params.prompt).toBe(
        composeFramePrompt(p, f),
      );
    }
  });
});

describe("gutter reconciliation (spec §3.3)", () => {
  it("moment/action/subject with no explicit continues auto-links to the predecessor", () => {
    const out = gutterReconcile([
      fr("a"),
      fr("b", { gutter: "action" }),
      fr("c", { gutter: "subject" }),
      fr("d", { gutter: "moment" }),
    ]);
    expect(out[1]!.continuesFrameId).toBe("a");
    expect(out[2]!.continuesFrameId).toBe("b");
    expect(out[3]!.continuesFrameId).toBe("c");
  });

  it("an explicit link is authoritative under a linking gutter — including non-adjacent", () => {
    // The framed-tale return: P4 action-continuing P1 keeps its explicit link.
    const out = gutterReconcile([
      fr("a"),
      fr("b", { gutter: "action" }),
      fr("c"),
      fr("d", { gutter: "action", continuesFrameId: "a" }),
    ]);
    expect(out[1]!.continuesFrameId).toBe("a"); // auto-link goes to ITS predecessor
    expect(out[3]!.continuesFrameId).toBe("a"); // NOT overwritten with "c"
  });

  it("scene/aspect/nonsequitur clear an adjacent (auto-shaped) link", () => {
    for (const gutter of ["scene", "aspect", "nonsequitur"] as const) {
      const out = gutterReconcile([
        fr("a"),
        fr("b", { gutter, continuesFrameId: "a" }),
      ]);
      expect(out[1]!.continuesFrameId).toBeUndefined();
    }
  });

  it("scene/aspect/nonsequitur never clear an explicit NON-adjacent link", () => {
    const out = gutterReconcile([
      fr("a"),
      fr("b"),
      fr("c"),
      fr("d", { gutter: "scene", continuesFrameId: "a" }), // the return to P1's scene
    ]);
    expect(out[3]!.continuesFrameId).toBe("a");
  });

  it("the first frame passes through untouched; pure — unchanged frames keep identity", () => {
    const frames = [fr("a", { gutter: "scene" }), fr("b"), fr("c", { gutter: "action" })];
    const out = gutterReconcile(frames);
    expect(out[0]).toBe(frames[0]); // no predecessor → untouched, even with a stale gutter
    expect(out[1]).toBe(frames[1]); // no gutter → untouched
    expect(out[2]).not.toBe(frames[2]); // reconciled → copied
    expect(out[2]!.continuesFrameId).toBe("b");
  });

  it("a junk self-link under a linking gutter shapes like 'no link' — auto-links to the predecessor", () => {
    // Compile drops self-links anyway; reconciliation must not treat one as an
    // authoritative explicit link, or the frame would keep a link that never feeds.
    const out = gutterReconcile([
      fr("a"),
      fr("b", { gutter: "action", continuesFrameId: "b" }),
    ]);
    expect(out[1]!.continuesFrameId).toBe("a");
  });
});

describe("rhythm warnings (advisory only)", () => {
  it("flags adjacent identical preset sizes — unless the gutter is moment", () => {
    const dup = [fr("a", { camera: "wide shot" }), fr("b", { camera: "wide shot" })];
    expect(rhythmWarnings({ frames: dup }).some((n) => n.includes("repeat the same wide shot"))).toBe(true);
    const held = [
      fr("a", { camera: "wide shot" }),
      fr("b", { camera: "wide shot", gutter: "moment" }), // a legitimate tight hold
    ];
    expect(rhythmWarnings({ frames: held }).some((n) => n.includes("repeat the same"))).toBe(false);
    // Free-text cameras simply don't participate.
    const free = [fr("a", { camera: "looking down the alley" }), fr("b", { camera: "looking down the alley" })];
    expect(rhythmWarnings({ frames: free })).toEqual([]);
  });

  it("advises when P3 isn't the episode's biggest size-jump (and stays quiet when it is)", () => {
    // wide → full → medium → xws: P3's jump (1) is smaller than others (2).
    const off = [
      fr("a", { camera: "wide shot" }),
      fr("b", { camera: "full shot, full body in frame" }),
      fr("c", { camera: "medium shot, waist up" }),
      fr("d", { camera: "extreme wide establishing shot" }),
    ];
    expect(rhythmWarnings({ frames: off }).some((n) => n.includes("biggest camera change"))).toBe(true);
    // wide → medium → extreme close-up → close: P3's jump ties for the largest. Quiet.
    const on = [
      fr("a", { camera: "wide shot" }),
      fr("b", { camera: "medium shot, waist up" }),
      fr("c", { camera: "extreme close-up" }),
      fr("d", { camera: "close-up" }),
    ];
    expect(rhythmWarnings({ frames: on }).some((n) => n.includes("biggest camera change"))).toBe(false);
  });

  it("flags the gutter budget: >1 scene, aspect past the first half, effort over the ceiling", () => {
    const frames = [
      fr("a"),
      fr("b", { gutter: "scene" }),
      fr("c", { gutter: "scene" }),
      fr("d", { gutter: "aspect" }),
    ];
    const notes = rhythmWarnings({ frames });
    expect(notes.some((n) => n.includes("2 scene jumps"))).toBe(true);
    expect(notes.some((n) => n.includes("aspect panel"))).toBe(true);
    // scene(5) + scene(5) + aspect(4) = 14 > 12.
    expect(notes.some((n) => n.includes("14 of 12"))).toBe(true);
    expect(GUTTER_EFFORT.moment).toBe(1); // the effort scale is data
  });

  it("reads the DraftModal's id-less parse stand-ins (no camera, no image, mapped links)", () => {
    // Mirrors the stand-in shape DraftModal feeds pre-apply: synthetic `String(i)`
    // ids, empty variants/refHashes, and the links under the same strictly-earlier
    // validation the apply path applies. Cameras don't exist at parse time, so the
    // shot-size checks stay quiet while the gutter-budget ones still fire.
    const standIn = (i: number, extra: Partial<ComicFrame>): ComicFrame =>
      ComicFrameSchema.parse({ id: String(i), prompt: `beat ${i}`, variants: [], refHashes: [], ...extra });
    const frames = [
      standIn(0, {}),
      standIn(1, { gutter: "scene" }),
      standIn(2, { gutter: "scene", continuesFrameId: "1" }),
      standIn(3, { gutter: "action", continuesFrameId: "1", echoFrameId: "0" }),
    ];
    const notes = rhythmWarnings({ frames });
    expect(notes.some((n) => n.includes("2 scene jumps"))).toBe(true);
    // The both-set contradiction is exactly what pre-apply review exists to catch.
    expect(notes.some((n) => n.includes("both an echo and a continuity link"))).toBe(true);
    expect(notes.some((n) => n.includes("repeat the same"))).toBe(false); // no cameras yet
  });
});

describe("prompt length ceiling (spec §14: directive stacking stays bounded)", () => {
  it("a fully-loaded frame prompt stays under the golden ceiling", () => {
    // Every v2 block on one frame: plan art direction, role flavor, camera, mood,
    // palette, transition, and the LONGEST composition directive (continuity
    // restage with identity sheets). One directive per concern — the ceiling only
    // has to catch accidental stacking or a runaway directive rewrite.
    const img = "a".repeat(64);
    const p = project({
      plan: {
        structure: "detonate",
        archetype: "rain-soaked neon night, mirrors everywhere, 70% dark values",
        strategy: "villain POV — the detective is never fully seen",
        theme: "vanity",
        motif: "the cracked mirror",
      },
      style: {
        theme: "muted ink wash, heavy grain, cinematic",
        model: "mock/gradient",
        seed: 7,
        palette: ["#556B2F", "warm sepia", "neon teal"],
      },
      cast: [
        { id: "h", name: "Hero", refHashes: ["b".repeat(64), "c".repeat(64)] },
        { id: "v", name: "Villain", refHashes: ["d".repeat(64)] },
      ],
      frames: [
        { id: "a", prompt: "opening", role: "establish", camera: "extreme wide establishing shot", resultHash: img },
        {
          id: "b",
          prompt:
            "The same alley moments later, the cracked mirror leaning against the bins catching the signage light, rain needling the puddles.",
          role: "payoff",
          gutter: "action",
          continuesFrameId: "a",
          camera: "low-angle shot looking up",
          mood: "coiled violence",
        },
      ],
    });
    const out = composeFramePrompt(p, p.frames[1]!);
    // Measured ~2.2k with the heaviest directive stack; the ceiling leaves
    // headroom for wording upkeep but trips long before a model chokes.
    expect(out.length).toBeLessThan(2600);
    expect(out.length).toBeGreaterThan(1000); // and it isn't silently truncated
  });
});
