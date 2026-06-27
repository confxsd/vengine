import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ComicProjectSchema, type ComicProject } from "@vengine/shared";
import { ProjectStore } from "./project-store.js";

let root: string;
let store: ProjectStore;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), "vengine-projects-"));
  store = new ProjectStore({ root });
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

// Loosely typed so frame literals can omit defaulted fields (variants); the
// schema validates the shape at parse time.
function project(over: Record<string, unknown> = {}): ComicProject {
  return ComicProjectSchema.parse({
    id: "p1",
    name: "P",
    frames: [{ id: "f1", prompt: "x" }],
    createdAt: "2026-06-28T00:00:00.000Z",
    updatedAt: "2026-06-28T00:00:00.000Z",
    ...over,
  });
}

describe("ProjectStore", () => {
  it("saves and loads, stamping updatedAt", async () => {
    const saved = await store.save(project());
    expect(saved.updatedAt).not.toBe("2026-06-28T00:00:00.000Z");
    expect((await store.get("p1")).name).toBe("P");
  });

  it("preserves resultHash + variants when a client save omits them", async () => {
    // Simulate a run write-back establishing generation output.
    await store.save(project());
    await store.update("p1", (p) => ({
      ...p,
      frames: p.frames.map((f) => ({
        ...f,
        resultHash: HASH_A,
        variants: [{ hash: HASH_A, seed: 1 }],
      })),
    }));
    // Client autosaves an edit, omitting generation output entirely.
    await store.save(project({ frames: [{ id: "f1", prompt: "edited" }] }));
    const after = await store.get("p1");
    expect(after.frames[0]!.prompt).toBe("edited"); // edit applied
    expect(after.frames[0]!.resultHash).toBe(HASH_A); // output preserved
    expect(after.frames[0]!.variants).toEqual([{ hash: HASH_A, seed: 1 }]); // history kept
  });

  it("union-merges variants instead of replacing", async () => {
    await store.save(
      project({ frames: [{ id: "f1", prompt: "x", variants: [{ hash: HASH_A, seed: 1 }] }] }),
    );
    await store.save(
      project({ frames: [{ id: "f1", prompt: "x", variants: [{ hash: HASH_B, seed: 2 }] }] }),
    );
    const after = await store.get("p1");
    expect(after.frames[0]!.variants).toEqual([
      { hash: HASH_A, seed: 1 },
      { hash: HASH_B, seed: 2 },
    ]);
  });

  it("drops removed frames and respects reorder by id", async () => {
    await store.save(project({ frames: [{ id: "f1", prompt: "a" }, { id: "f2", prompt: "b" }] }));
    await store.save(project({ frames: [{ id: "f2", prompt: "b" }] }));
    const after = await store.get("p1");
    expect(after.frames.map((f) => f.id)).toEqual(["f2"]);
  });

  it("serializes concurrent saves without losing the last write", async () => {
    await store.save(project());
    // Fire many saves at once; the per-id lock must apply them without a torn
    // file or a lost final value.
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        store.save(project({ name: `v${i}`, frames: [{ id: "f1", prompt: `p${i}` }] })),
      ),
    );
    const after = await store.get("p1"); // must parse — i.e. not corrupted
    expect(after.frames).toHaveLength(1);
    expect(after.name).toMatch(/^v\d+$/);
  });

  it("lists projects with a cover hash from the first imaged frame", async () => {
    await store.save(project({ id: "p1" }));
    await store.update("p1", (p) => ({
      ...p,
      frames: p.frames.map((f) => ({ ...f, resultHash: HASH_A })),
    }));
    const list = await store.list();
    expect(list.find((s) => s.id === "p1")?.coverHash).toBe(HASH_A);
  });

  it("snapshots the current document", async () => {
    await store.save(project());
    const snap = await store.createSnapshot("p1");
    const snaps = await store.listSnapshots("p1");
    expect(snaps.map((s) => s.id)).toContain(snap.id);
  });
});
