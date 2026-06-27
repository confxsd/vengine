import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FileOutputCache } from "./output-cache.js";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), "vengine-cache-"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const KEY = "a".repeat(64);
const OUTPUTS = { image: { hash: "b".repeat(64), mime: "image/png", width: 768, height: 1344 } };

describe("FileOutputCache", () => {
  it("misses for an unknown key", async () => {
    const cache = new FileOutputCache({ root });
    expect(await cache.get(KEY)).toBeUndefined();
  });

  it("round-trips outputs", async () => {
    const cache = new FileOutputCache({ root });
    await cache.set(KEY, OUTPUTS);
    expect(await cache.get(KEY)).toEqual(OUTPUTS);
  });

  it("persists across instances (survives a 'restart')", async () => {
    await new FileOutputCache({ root }).set(KEY, OUTPUTS);
    // A fresh instance with no memo must still hit from disk.
    const fresh = new FileOutputCache({ root });
    expect(await fresh.get(KEY)).toEqual(OUTPUTS);
  });

  it("shards by the key prefix", async () => {
    await new FileOutputCache({ root }).set(KEY, OUTPUTS);
    const sharded = path.join(root, KEY.slice(0, 2), `${KEY}.json`);
    await expect(fs.access(sharded)).resolves.toBeUndefined();
  });
});
