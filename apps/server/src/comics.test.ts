import { describe, it, expect } from "vitest";
import { ComicProjectSchema, type ComicProject } from "@vengine/shared";
import { partitionWaves } from "./comics.js";

function project(overrides: Record<string, unknown> = {}): ComicProject {
  return ComicProjectSchema.parse({
    id: "p1",
    name: "Waves",
    frames: [
      { id: "a", prompt: "1" },
      { id: "b", prompt: "2" },
      { id: "c", prompt: "3" },
      { id: "d", prompt: "4" },
    ],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  });
}

/** Wave schedule as frame-id lists (the readable form of the assertions below). */
const ids = (waves: ReturnType<typeof partitionWaves>) => waves.map((w) => w.map((f) => f.id));

describe("partitionWaves (the wave runner's schedule, spec EPISODE_STUDIO §7)", () => {
  it("interleaved case: [1,2,3] then [4] when frame 4 continues frame 1", () => {
    const p = project({
      frames: [
        { id: "a", prompt: "1" },
        { id: "b", prompt: "2" },
        { id: "c", prompt: "3" },
        { id: "d", prompt: "4", continuesFrameId: "a" },
      ],
    });
    expect(ids(partitionWaves(p, ["a", "b", "c", "d"]))).toEqual([["a", "b", "c"], ["d"]]);
  });

  it("a chain serializes: each continuation waits for its source's wave", () => {
    const p = project({
      frames: [
        { id: "a", prompt: "1" },
        { id: "b", prompt: "2", continuesFrameId: "a" },
        { id: "c", prompt: "3", continuesFrameId: "b" },
        { id: "d", prompt: "4", continuesFrameId: "c" },
      ],
    });
    expect(ids(partitionWaves(p, ["a", "b", "c", "d"]))).toEqual([["a"], ["b"], ["c"], ["d"]]);
  });

  it("independent frames share ONE wave — only linked chains serialize", () => {
    expect(ids(partitionWaves(project(), ["a", "b", "c", "d"]))).toEqual([["a", "b", "c", "d"]]);
  });

  it("a source that already has an image unblocks its continuation in the same wave", () => {
    const img = "d".repeat(64);
    const p = project({
      frames: [
        { id: "a", prompt: "1", resultHash: img },
        { id: "b", prompt: "2" },
        { id: "c", prompt: "3" },
        { id: "d", prompt: "4", continuesFrameId: "a" },
      ],
    });
    expect(ids(partitionWaves(p, ["a", "b", "c", "d"]))).toEqual([["a", "b", "c", "d"]]);
  });

  it("a fully generated episode re-runs as a single wave (unchanged frames are cache hits)", () => {
    // Re-running compiles identical inputs, so the content-addressed cache makes
    // every frame free; the schedule must not split what doesn't need to wait.
    const img = "e".repeat(64);
    const p = project({
      frames: [
        { id: "a", prompt: "1", resultHash: img },
        { id: "b", prompt: "2", resultHash: "f".repeat(64) },
        { id: "c", prompt: "3", resultHash: "1".repeat(64) },
        { id: "d", prompt: "4", continuesFrameId: "a", resultHash: img },
      ],
    });
    expect(ids(partitionWaves(p, ["a", "b", "c", "d"]))).toEqual([["a", "b", "c", "d"]]);
  });

  it("an echo dependency waits for its source like a continuation (the bookend payout)", () => {
    const p = project({
      frames: [
        { id: "a", prompt: "1" },
        { id: "b", prompt: "2" },
        { id: "c", prompt: "3" },
        { id: "d", prompt: "4", echoFrameId: "a" },
      ],
    });
    expect(ids(partitionWaves(p, ["a", "b", "c", "d"]))).toEqual([["a", "b", "c"], ["d"]]);
  });

  it("links outside the selection never block a subset run", () => {
    const p = project({
      frames: [
        { id: "a", prompt: "1" },
        { id: "b", prompt: "2" },
        { id: "c", prompt: "3" },
        { id: "d", prompt: "4", continuesFrameId: "a" }, // source NOT in this run
      ],
    });
    expect(ids(partitionWaves(p, ["d"]))).toEqual([["d"]]);
  });

  it("unknown frame ids in the request are ignored", () => {
    expect(ids(partitionWaves(project(), ["a", "ghost"]))).toEqual([["a"]]);
    expect(partitionWaves(project(), [])).toEqual([]);
  });

  it("a defensive cycle falls through to a final wave — a run never breaks", () => {
    // Impossible via strictly-earlier validation, but a hand-edited document
    // could contain one; the remainder runs together and compile drops the
    // unresolved links exactly as `continuityReferences` does today.
    const p = project({
      frames: [
        { id: "a", prompt: "1" },
        { id: "b", prompt: "2", continuesFrameId: "d" },
        { id: "c", prompt: "3" },
        { id: "d", prompt: "4", continuesFrameId: "b" },
      ],
    });
    expect(ids(partitionWaves(p, ["a", "b", "c", "d"]))).toEqual([["a", "c"], ["b", "d"]]);
  });
});
