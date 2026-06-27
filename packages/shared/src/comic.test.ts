import { describe, it, expect } from "vitest";
import {
  ComicProjectSchema,
  compileComic,
  composeFramePrompt,
  genNodeId,
  exportNodeId,
  frameIdFromNodeId,
  unionVariants,
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

  it("includes the anchor hash in referenceHashes only when set", () => {
    const anchor = "f".repeat(64);
    const withAnchor = compileComic(project({ style: { ...project().style, anchorHash: anchor } }));
    expect(withAnchor.nodes.find((n) => n.id === genNodeId("a"))!.params.referenceHashes).toEqual([
      anchor,
    ]);
    const without = compileComic(project());
    expect(without.nodes.find((n) => n.id === genNodeId("a"))!.params.referenceHashes).toBeUndefined();
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
