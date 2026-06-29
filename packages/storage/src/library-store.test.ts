import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LibraryStore } from "./library-store.js";

let root: string;
let store: LibraryStore;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), "vengine-library-"));
  store = new LibraryStore({ root });
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const HASH_A = "a".repeat(64);

describe("LibraryStore", () => {
  it("reads an empty library before anything is written", async () => {
    const lib = await store.get();
    expect(lib).toEqual({ characters: [], styles: [], trainedLoras: [] });
  });

  it("upserts a character, stamping timestamps, then updates in place", async () => {
    const created = await store.upsertCharacter({
      id: "yue",
      name: "Yue",
      refHashes: [HASH_A],
      description: "an exiled moon-goddess in rabbit form",
      palette: ["#F4F2F0", "#B6B7D6"],
      tags: [],
    } as never);
    expect(created.createdAt).toBeDefined();
    expect(created.updatedAt).toBeDefined();

    const renamed = await store.upsertCharacter({ ...created, name: "Yue (moon rabbit)" } as never);
    expect(renamed.name).toBe("Yue (moon rabbit)");
    expect(renamed.createdAt).toBe(created.createdAt); // preserved across update

    const lib = await store.get();
    expect(lib.characters).toHaveLength(1); // updated, not duplicated
    expect(lib.characters[0]!.name).toBe("Yue (moon rabbit)");
  });

  it("persists across store instances (same root)", async () => {
    await store.upsertStyle({ id: "oil", name: "Oil Painting", theme: "thick impasto" } as never);
    const reopened = new LibraryStore({ root });
    const lib = await reopened.get();
    expect(lib.styles.map((s) => s.id)).toEqual(["oil"]);
  });

  it("patches a training record on completion", async () => {
    await store.upsertTrainedLora({ id: "t1", name: "Yue LoRA", status: "training" } as never);
    const done = await store.patchTrainedLora("t1", {
      status: "ready",
      loraUrl: "https://fal/yue.safetensors",
    });
    expect(done?.status).toBe("ready");
    expect(done?.loraUrl).toBe("https://fal/yue.safetensors");
  });

  it("patchTrainedLora is a no-op for a deleted id", async () => {
    expect(await store.patchTrainedLora("gone", { status: "ready" })).toBeUndefined();
  });

  it("removing a trained LoRA detaches characters that pointed at it", async () => {
    await store.upsertTrainedLora({ id: "t1", name: "Yue LoRA", status: "ready" } as never);
    await store.upsertCharacter({ id: "yue", name: "Yue", loraId: "t1" } as never);
    await store.removeTrainedLora("t1");
    const lib = await store.get();
    expect(lib.trainedLoras).toHaveLength(0);
    expect(lib.characters[0]!.loraId).toBeUndefined(); // no dangling reference
  });

  it("ensureStyles seeds missing packs but never overwrites existing ones", async () => {
    await store.upsertStyle({ id: "builtin-comic", name: "My Edited Comic", theme: "custom" } as never);
    await store.ensureStyles([
      { id: "builtin-comic", name: "Contemporary Comic" } as never, // already present → keep user's edit
      { id: "builtin-oil", name: "Oil Painting" } as never, // missing → seed
    ]);
    const lib = await store.get();
    expect(lib.styles.map((s) => s.id).sort()).toEqual(["builtin-comic", "builtin-oil"]);
    expect(lib.styles.find((s) => s.id === "builtin-comic")!.name).toBe("My Edited Comic");
  });

  it("serializes concurrent upserts without losing writes", async () => {
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        store.upsertCharacter({ id: `c${i}`, name: `C${i}` } as never),
      ),
    );
    const lib = await store.get();
    expect(lib.characters).toHaveLength(12); // no lost updates under the mutex
  });
});
