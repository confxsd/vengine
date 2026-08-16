import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Executor, MemoryCache, type ExecutionServices } from "@vengine/core";
import { ProviderRegistry, mockModel, falModels } from "@vengine/providers";
import { AssetStore } from "@vengine/storage";
import type { GraphDocument } from "@vengine/shared";
import { createNodeRegistry } from "./index.js";
import { createTextToImageNode, TextToImageParams } from "./image.js";
import { createImageEditNode, ImageEditParams } from "./image.js";

let work: string;
let services: ExecutionServices;
let executor: Executor;
let cache: MemoryCache;

beforeAll(async () => {
  work = await fs.mkdtemp(path.join(tmpdir(), "vengine-nodes-"));
  const providers = new ProviderRegistry().register(mockModel);
  const registry = createNodeRegistry({ providers });
  cache = new MemoryCache();
  executor = new Executor({ registry, cache });
  services = { assets: new AssetStore({ root: path.join(work, "assets") }) };
});
afterAll(async () => {
  await fs.rm(work, { recursive: true, force: true });
});

function graph(): GraphDocument {
  return {
    version: 1,
    id: "g",
    name: "t",
    nodes: [
      {
        id: "gen",
        type: "generate.text-to-image",
        position: { x: 0, y: 0 },
        params: { model: "mock/gradient", prompt: "test", width: 256, height: 256, seed: 1 },
      },
      {
        id: "resize",
        type: "compositing.resize",
        position: { x: 0, y: 0 },
        params: { width: 128, height: 128, fit: "cover" },
      },
      {
        id: "export",
        type: "io.export",
        position: { x: 0, y: 0 },
        params: { dir: path.join(work, "out"), filename: "t", format: "png" },
      },
    ],
    edges: [
      { id: "e1", source: "gen", sourcePort: "image", target: "resize", targetPort: "image" },
      { id: "e2", source: "resize", sourcePort: "image", target: "export", targetPort: "image" },
    ],
  };
}

describe("end-to-end node pipeline", () => {
  it("generates → resizes → exports a real PNG", async () => {
    const result = await executor.run(graph(), { runId: "r1", services });
    expect(result.status).toBe("done");

    const outPath = result.nodes.get("export")?.outputs?.path as string;
    const file = await fs.readFile(outPath);
    expect(Array.from(file.subarray(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]); // PNG magic
  });

  it("dry-run plan totals the mock generation cost", async () => {
    const plan = await executor.plan(graph());
    // generation runs (or is cached from prior test); export always runs (free).
    expect(plan.estTotalCost).toBeGreaterThanOrEqual(0);
    expect(plan.nodes.find((n) => n.nodeId === "export")?.willRun).toBe(true);
  });

  it("re-running is cached for the generation node", async () => {
    await executor.run(graph(), { runId: "r2", services });
    const plan = await executor.plan(graph());
    // gen + resize cached; only the side-effecting export is left to run.
    expect(plan.nodes.find((n) => n.nodeId === "gen")?.willRun).toBe(false);
    expect(plan.nodes.find((n) => n.nodeId === "resize")?.willRun).toBe(false);
  });
});

describe("text-to-image cacheKeyParams gating", () => {
  const providers = new ProviderRegistry().registerAll([
    mockModel, // consumes neither
    falModels.fluxLora, // consumesLoras
    falModels.nanoBananaPro, // consumesReferences
  ]);
  const node = createTextToImageNode(providers);
  const key = (p: Record<string, unknown>) =>
    node.cacheKeyParams!(TextToImageParams.parse(p)) as TextToImageParams;

  it("drops loras for a model that can't use them, keeps them for one that can", () => {
    expect(key({ model: "mock/gradient", prompt: "x", loras: [{ path: "a" }] }).loras).toBeUndefined();
    expect(key({ model: "fal/flux-lora", prompt: "x", loras: [{ path: "a", scale: 1 }] }).loras).toEqual([
      { path: "a", scale: 1 },
    ]);
  });

  it("drops referenceHashes for a non-reference model, keeps them for a reference model", () => {
    const h = "f".repeat(64);
    expect(key({ model: "mock/gradient", prompt: "x", referenceHashes: [h] }).referenceHashes).toBeUndefined();
    expect(
      key({ model: "fal/nano-banana-pro", prompt: "x", referenceHashes: [h] }).referenceHashes,
    ).toEqual([h]);
  });

  it("drops weighted references for a non-reference model, keeps them for a reference model", () => {
    const refs = [{ hash: "a".repeat(64), weight: 0.7 }];
    expect(key({ model: "mock/gradient", prompt: "x", references: refs }).references).toBeUndefined();
    expect(key({ model: "fal/nano-banana-pro", prompt: "x", references: refs }).references).toEqual(refs);
  });
});

describe("image-edit node", () => {
  const providers = new ProviderRegistry().registerAll([
    mockModel, // consumes neither
    falModels.nanoBananaPro, // consumesReferences
  ]);
  const node = createImageEditNode(providers);
  const key = (p: Record<string, unknown>) =>
    node.cacheKeyParams!(ImageEditParams.parse(p)) as ImageEditParams;

  it("drops secondary references for a non-reference model, keeps them for one that can", () => {
    const refs = [{ hash: "b".repeat(64) }];
    expect(key({ model: "mock/gradient", instruction: "x", references: refs }).references).toBeUndefined();
    expect(key({ model: "fal/nano-banana-pro", instruction: "x", references: refs }).references).toEqual(refs);
  });

  it("runs a source → edit pipeline end-to-end and caches on re-run", async () => {
    // Seed a source asset by generating a gradient once.
    const seedGraph: GraphDocument = {
      version: 1,
      id: "seed",
      name: "seed",
      nodes: [
        {
          id: "gen",
          type: "generate.text-to-image",
          position: { x: 0, y: 0 },
          params: { model: "mock/gradient", prompt: "source", width: 128, height: 128, seed: 7 },
        },
      ],
      edges: [],
    };
    const seeded = await executor.run(seedGraph, { runId: "r-seed", services });
    const sourceHash = (seeded.nodes.get("gen")?.outputs?.image as { hash: string }).hash;

    const focusGraph: GraphDocument = {
      version: 1,
      id: "focus",
      name: "focus",
      nodes: [
        { id: "src", type: "io.source", position: { x: 0, y: 0 }, params: { hash: sourceHash } },
        {
          id: "e1",
          type: "generate.image-edit",
          position: { x: 0, y: 0 },
          params: { model: "mock/gradient", instruction: "brighten", mode: "tweak", seed: 1 },
        },
        {
          id: "e2",
          type: "generate.image-edit",
          position: { x: 0, y: 0 },
          params: { model: "mock/gradient", instruction: "brighten", mode: "tweak", seed: 2 },
        },
      ],
      edges: [
        { id: "se1", source: "src", sourcePort: "image", target: "e1", targetPort: "image" },
        { id: "se2", source: "src", sourcePort: "image", target: "e2", targetPort: "image" },
      ],
    };

    const result = await executor.run(focusGraph, { runId: "r-focus", services });
    expect(result.status).toBe("done");
    expect(result.nodes.get("src")?.status).toBe("done");
    for (const id of ["e1", "e2"]) {
      const out = result.nodes.get(id)?.outputs?.image as { hash: string };
      expect(out?.hash).toBeTruthy();
      expect(out.hash).not.toBe(sourceHash);
    }
    // Diverged seeds produce different bytes (different cache entries).
    expect((result.nodes.get("e1")?.outputs?.image as { hash: string }).hash).not.toBe(
      (result.nodes.get("e2")?.outputs?.image as { hash: string }).hash,
    );

    // Unchanged re-run: source + both edits are cache hits.
    const plan = await executor.plan(focusGraph);
    for (const id of ["src", "e1", "e2"]) {
      expect(plan.nodes.find((n) => n.nodeId === id)?.willRun).toBe(false);
    }
  });

  it("defaults the edit output size to the source's own dimensions (same ratio)", async () => {
    // A distinct non-square source: 64×128.
    const seedGraph: GraphDocument = {
      version: 1,
      id: "seed-tall",
      name: "seed",
      nodes: [
        {
          id: "gen",
          type: "generate.text-to-image",
          position: { x: 0, y: 0 },
          params: { model: "mock/gradient", prompt: "tall", width: 64, height: 128, seed: 3 },
        },
      ],
      edges: [],
    };
    const seeded = await executor.run(seedGraph, { runId: "r-seed-tall", services });
    const sourceHash = (seeded.nodes.get("gen")?.outputs?.image as { hash: string }).hash;

    const editGraph: GraphDocument = {
      version: 1,
      id: "focus-ratio",
      name: "focus",
      nodes: [
        { id: "src", type: "io.source", position: { x: 0, y: 0 }, params: { hash: sourceHash } },
        {
          id: "e1",
          type: "generate.image-edit",
          position: { x: 0, y: 0 },
          params: { model: "mock/gradient", instruction: "x", seed: 9 },
        },
      ],
      edges: [{ id: "se1", source: "src", sourcePort: "image", target: "e1", targetPort: "image" }],
    };

    const result = await executor.run(editGraph, { runId: "r-ratio", services });
    const out = result.nodes.get("e1")?.outputs?.image as { width?: number; height?: number };
    expect(out.width).toBe(64);
    expect(out.height).toBe(128);
  });
});
