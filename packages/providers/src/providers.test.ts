import { describe, it, expect } from "vitest";
import { ProviderRegistry } from "./registry.js";
import { mockModel } from "./adapters/mock.js";
import { falModels } from "./adapters/fal.js";

describe("mock model", () => {
  it("produces a valid PNG", async () => {
    const out = await mockModel.run({ prompt: "a calm seascape" }, {});
    expect(out.mime).toBe("image/png");
    // PNG magic bytes
    expect(Array.from(out.bytes.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(out.costUsd).toBeGreaterThan(0);
  });

  it("is deterministic for identical inputs", async () => {
    const a = await mockModel.run({ prompt: "x", seed: 1 }, {});
    const b = await mockModel.run({ prompt: "x", seed: 1 }, {});
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
  });

  it("preview path is cheaper and smaller", async () => {
    const preview = await mockModel.run({ prompt: "x", quality: "preview" }, {});
    const final = await mockModel.run({ prompt: "x", quality: "final" }, {});
    expect(preview.costUsd).toBeLessThan(final.costUsd);
    expect((preview.width ?? 0)).toBeLessThan(final.width ?? 0);
  });
});

describe("ProviderRegistry", () => {
  it("lists models by capability", () => {
    const reg = new ProviderRegistry().registerAll([mockModel, falModels.nanoBananaPro]);
    const t2i = reg.listByCapability("text-to-image").map((m) => m.id);
    expect(t2i).toContain("mock/gradient");
    expect(reg.listByCapability("edit").map((m) => m.id)).toContain("fal/nano-banana-pro");
  });

  it("fal estimateCost handles per-megapixel pricing", () => {
    const cost = falModels.qwenImage.estimateCost({ width: 1000, height: 1000 });
    expect(cost).toBeCloseTo(0.02); // 1 MP * $0.02
  });
});
