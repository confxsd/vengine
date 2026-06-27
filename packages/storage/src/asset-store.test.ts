import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { AssetStore } from "./asset-store.js";

let root: string;
let store: AssetStore;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), "vengine-assets-"));
  store = new AssetStore({ root });
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function redPng(): Promise<Uint8Array> {
  const buf = await sharp({
    create: { width: 16, height: 16, channels: 3, background: { r: 255, g: 0, b: 0 } },
  })
    .png()
    .toBuffer();
  return new Uint8Array(buf);
}

describe("AssetStore", () => {
  it("stores image bytes content-addressed with metadata", async () => {
    const bytes = await redPng();
    const ref = await store.put(bytes, "image/png");

    expect(ref.hash).toHaveLength(64);
    expect(ref.width).toBe(16);
    expect(ref.height).toBe(16);
    expect(await store.has(ref.hash)).toBe(true);

    const back = await store.get(ref.hash);
    expect(Buffer.from(bytes).equals(back)).toBe(true);
  });

  it("dedups identical content to the same hash", async () => {
    const bytes = await redPng();
    const a = await store.put(bytes, "image/png");
    const b = await store.put(bytes, "image/png");
    expect(a.hash).toBe(b.hash);
  });

  it("writes a thumbnail", async () => {
    const ref = await store.put(await redPng(), "image/png");
    await fs.access(store.thumbPath(ref.hash)); // throws if missing
  });
});
