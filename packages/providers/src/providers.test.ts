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

interface Captured {
  body?: Record<string, unknown>;
  /** The submit endpoint URL — reveals base-vs-edit routing. */
  url?: string;
}

/** Mock fal's queue contract (submit → status → result → image download),
 *  capturing the submitted request body + URL so routing/mapping is observable. */
function mockFalFetch(captured: Captured): typeof fetch {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  return (async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const u = String(url);
    if (init?.method === "POST" && !u.includes("/requests/")) {
      captured.body = JSON.parse(String(init.body));
      captured.url = u;
      return new Response(JSON.stringify({ request_id: "req-1" }), { status: 200 });
    }
    if (u.endsWith("/status")) {
      return new Response(JSON.stringify({ status: "COMPLETED" }), { status: 200 });
    }
    if (u.includes("/requests/req-1")) {
      return new Response(
        JSON.stringify({ images: [{ url: "https://img/1.png", content_type: "image/png" }], seed: 7 }),
        { status: 200 },
      );
    }
    if (u === "https://img/1.png") return new Response(png, { status: 200 });
    return new Response(`unexpected ${u}`, { status: 500 });
  }) as typeof fetch;
}

describe("fal reference images", () => {
  it("routes references to the /edit endpoint with data URIs, t2i otherwise", async () => {
    // With references → edit endpoint + image_urls.
    const withRefs: Captured = {};
    const out = await falModels.nanoBananaPro.run(
      { prompt: "hero", references: [{ bytes: new Uint8Array([1, 2, 3]), mime: "image/png" }] },
      { apiKey: "k", fetch: mockFalFetch(withRefs) },
    );
    expect(falModels.nanoBananaPro.consumesReferences).toBe(true);
    expect(withRefs.url).toContain("/gemini-3-pro-image-preview/edit");
    const urls = withRefs.body?.image_urls as string[];
    expect(urls).toHaveLength(1);
    expect(urls[0]).toMatch(/^data:image\/png;base64,/);
    expect(out.seed).toBe(7);

    // Without references → base text-to-image endpoint, no image field.
    const noRefs: Captured = {};
    await falModels.nanoBananaPro.run({ prompt: "hero" }, { apiKey: "k", fetch: mockFalFetch(noRefs) });
    expect(noRefs.url).toContain("/gemini-3-pro-image-preview");
    expect(noRefs.url).not.toContain("/edit");
    expect(noRefs.body?.image_urls).toBeUndefined();
  });

  it("flux-2 routes references to its /edit endpoint", async () => {
    const captured: Captured = {};
    await falModels.fluxProV2.run(
      { prompt: "x", references: [{ bytes: new Uint8Array([9]), mime: "image/png" }] },
      { apiKey: "k", fetch: mockFalFetch(captured) },
    );
    expect(captured.url).toContain("/flux-2-pro/edit");
    expect((captured.body?.image_urls as string[]).length).toBe(1);
  });

  it("caps references at the model's limit", async () => {
    const captured: Captured = {};
    const many = Array.from({ length: 8 }, (_, i) => ({
      bytes: new Uint8Array([i]),
      mime: "image/png",
    }));
    await falModels.nanoBananaPro.run(
      { prompt: "x", references: many },
      { apiKey: "k", fetch: mockFalFetch(captured) },
    );
    expect((captured.body?.image_urls as string[]).length).toBe(5); // maxReferences
    // The cap is also exposed on the public adapter so the UI can warn before a run.
    expect(falModels.nanoBananaPro.maxReferences).toBe(5);
    expect(falModels.seedream.maxReferences).toBeUndefined();
  });

  it("non-edit models never advertise or receive references", async () => {
    expect(falModels.seedream.consumesReferences).toBe(false);
    const captured: Captured = {};
    await falModels.seedream.run(
      { prompt: "x", references: [{ bytes: new Uint8Array([1]), mime: "image/png" }] },
      { apiKey: "k", fetch: mockFalFetch(captured) },
    );
    expect(captured.url).not.toContain("/edit");
    expect(captured.body?.image_urls).toBeUndefined();
  });
});

describe("gemini dimension mapping", () => {
  it("maps a 9:16 pixel size to aspect_ratio, not image_size", async () => {
    const captured: Captured = {};
    await falModels.nanoBananaPro.run(
      { prompt: "x", width: 768, height: 1344 },
      { apiKey: "k", fetch: mockFalFetch(captured) },
    );
    expect(captured.body?.aspect_ratio).toBe("9:16");
    expect(captured.body?.image_size).toBeUndefined(); // gemini has no image_size
    expect(captured.body?.negative_prompt).toBeUndefined(); // nor negative prompt
  });

  it("picks the nearest ratio for non-exact sizes (square-ish → 1:1)", async () => {
    const captured: Captured = {};
    await falModels.nanoBananaPro.run(
      { prompt: "x", width: 1024, height: 1000 },
      { apiKey: "k", fetch: mockFalFetch(captured) },
    );
    expect(captured.body?.aspect_ratio).toBe("1:1");
  });
});

describe("fal LoRA", () => {
  it("flux-lora forwards loras (defaulting scale) and advertises consumption", async () => {
    const captured: Captured = {};
    await falModels.fluxLora.run(
      { prompt: "x", loras: [{ path: "https://h/a.safetensors", scale: 0.8 }, { path: "b" }] },
      { apiKey: "k", fetch: mockFalFetch(captured) },
    );
    expect(falModels.fluxLora.consumesLoras).toBe(true);
    expect(captured.body?.loras).toEqual([
      { path: "https://h/a.safetensors", scale: 0.8 },
      { path: "b", scale: 1 }, // missing scale defaults to full strength
    ]);
  });

  it("flux-2-lora routes to the FLUX.2 LoRA endpoint and forwards loras", async () => {
    const captured: Captured = {};
    await falModels.flux2Lora.run(
      { prompt: "x", loras: [{ path: "https://h/style.safetensors", scale: 0.9 }] },
      { apiKey: "k", fetch: mockFalFetch(captured) },
    );
    expect(captured.url).toContain("/flux-2/lora");
    expect(falModels.flux2Lora.consumesLoras).toBe(true);
    expect(captured.body?.loras).toEqual([{ path: "https://h/style.safetensors", scale: 0.9 }]);
  });

  it("non-LoRA models never emit a loras field", async () => {
    const captured: Captured = {};
    await falModels.seedream.run(
      { prompt: "x", loras: [{ path: "ignored" }] },
      { apiKey: "k", fetch: mockFalFetch(captured) },
    );
    expect(captured.body?.loras).toBeUndefined();
    expect(falModels.seedream.consumesLoras).toBeUndefined();
  });

  it("caps merged LoRAs at the endpoint's limit (Qwen = 3), keeping the earliest", async () => {
    const captured: Captured = {};
    await falModels.qwenLora.run(
      {
        prompt: "x",
        loras: [
          { path: "style", scale: 1 }, // style leads (frameLoras emits it first)
          { path: "yue", scale: 1 },
          { path: "boy", scale: 1 },
          { path: "socrates", scale: 1 }, // 4th — must be dropped
        ],
      },
      { apiKey: "k", fetch: mockFalFetch(captured) },
    );
    const loras = captured.body?.loras as Array<{ path: string }>;
    expect(loras).toHaveLength(3);
    expect(loras.map((l) => l.path)).toEqual(["style", "yue", "boy"]);
  });
});

describe("fal request cancellation", () => {
  /** A fetch that never resolves on its own — it only settles when the request's
   *  signal aborts, modelling a half-open fal connection. The per-request timeout
   *  is merged onto `ctx.signal`, so a user cancel must still tear this down. */
  const hangingFetch: typeof fetch = ((_url: string | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return; // would hang forever — but the adapter always passes one
      if (signal.aborted) return reject(signal.reason as Error);
      signal.addEventListener("abort", () => reject(signal.reason as Error), { once: true });
    })) as typeof fetch;

  it("a cancelled run aborts the in-flight fal request instead of hanging", async () => {
    const ac = new AbortController();
    const run = falModels.seedream.run(
      { prompt: "x" },
      { apiKey: "k", fetch: hangingFetch, signal: ac.signal },
    );
    ac.abort();
    await expect(run).rejects.toThrow();
  });
});

describe("fal queue URL routing (405 regression)", () => {
  /** Records every non-POST URL the adapter polls/fetches, so we can assert it
   *  honors fal's returned status_url/response_url instead of reconstructing them. */
  function trackingFetch(polled: string[]): typeof fetch {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    return (async (url: string | URL, init?: RequestInit): Promise<Response> => {
      const u = String(url);
      if (init?.method === "POST" && u.includes("queue.fal.run")) {
        // Sub-pathed edit endpoint: fal roots the queue URLs at the APP, sans "/edit".
        return new Response(
          JSON.stringify({
            request_id: "r9",
            status_url: "https://queue.fal.run/fal-ai/gemini-3-pro-image-preview/requests/r9/status",
            response_url: "https://queue.fal.run/fal-ai/gemini-3-pro-image-preview/requests/r9",
          }),
          { status: 200 },
        );
      }
      polled.push(u);
      if (u.endsWith("/status")) return new Response(JSON.stringify({ status: "COMPLETED" }), { status: 200 });
      if (u.endsWith("/requests/r9"))
        return new Response(JSON.stringify({ images: [{ url: "https://img/x.png" }] }), { status: 200 });
      if (u === "https://img/x.png") return new Response(png, { status: 200 });
      return new Response(`unexpected ${u}`, { status: 405 }); // reconstructed URL would 405
    }) as typeof fetch;
  }

  it("polls fal's returned status_url, not a reconstruction of the sub-pathed endpoint", async () => {
    const polled: string[] = [];
    await falModels.nanoBananaPro.run(
      { prompt: "hero", references: [{ bytes: new Uint8Array([1]), mime: "image/png" }] },
      { apiKey: "k", fetch: trackingFetch(polled) },
    );
    // Must hit the APP-rooted status URL fal returned…
    expect(polled).toContain("https://queue.fal.run/fal-ai/gemini-3-pro-image-preview/requests/r9/status");
    // …and never the wrong "/edit/requests/..." reconstruction that caused the 405.
    expect(polled.some((u) => u.includes("/edit/requests/"))).toBe(false);
  });
});
