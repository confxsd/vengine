import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { falTrainers } from "./adapters/fal-training.js";
import { buildDatasetDataUri } from "./adapters/dataset.js";
import { __test } from "./adapters/dataset.js";
import type { TrainingExample } from "./types.js";

/** A real, decodable PNG so the dataset builder's sharp pipeline has valid input. */
async function pngBytes(color: string): Promise<Uint8Array> {
  const buf = await sharp({
    create: { width: 32, height: 32, channels: 3, background: color },
  })
    .png()
    .toBuffer();
  return new Uint8Array(buf);
}

/** Read the ZIP End-Of-Central-Directory "total entries" field (offset 10, LE u16). */
function zipEntryCount(zip: Uint8Array): number {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const eocd = zip.length - 22; // no comment, so EOCD is the final 22 bytes
  expect(dv.getUint32(eocd, true)).toBe(0x06054b50); // EOCD signature
  return dv.getUint16(eocd + 10, true);
}

function dataUriToBytes(dataUri: string): Uint8Array {
  const b64 = dataUri.slice(dataUri.indexOf(",") + 1);
  return new Uint8Array(Buffer.from(b64, "base64"));
}

describe("store-only zip", () => {
  it("writes a valid archive with one entry per file", () => {
    const enc = new TextEncoder();
    const zip = __test.buildZip([
      { name: "0001.jpg", data: enc.encode("fake-image-bytes") },
      { name: "0001.txt", data: enc.encode("a caption") },
    ]);
    // Local file header signature leads the archive.
    expect(Array.from(zip.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(zipEntryCount(zip)).toBe(2);
  });

  it("crc32 matches a known IEEE value", () => {
    // CRC-32 of ASCII "123456789" is the standard check value 0xCBF43926.
    expect(__test.crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });
});

describe("dataset builder", () => {
  it("packs images as an inline zip data URI, one .jpg per image", async () => {
    const examples: TrainingExample[] = [
      { bytes: await pngBytes("#ff0000"), mime: "image/png" },
      { bytes: await pngBytes("#00ff00"), mime: "image/png" },
    ];
    const { dataUri } = await buildDatasetDataUri(examples);
    expect(dataUri.startsWith("data:application/zip;base64,")).toBe(true);
    expect(zipEntryCount(dataUriToBytes(dataUri))).toBe(2); // two images, no captions
  });

  it("adds a same-named .txt entry for each caption", async () => {
    const examples: TrainingExample[] = [
      { bytes: await pngBytes("#ff0000"), mime: "image/png", caption: "YUE, side view" },
      { bytes: await pngBytes("#00ff00"), mime: "image/png" }, // no caption
    ];
    const { dataUri } = await buildDatasetDataUri(examples);
    // 2 images + 1 caption file = 3 entries.
    expect(zipEntryCount(dataUriToBytes(dataUri))).toBe(3);
  });

  it("rejects an empty dataset", async () => {
    await expect(buildDatasetDataUri([])).rejects.toThrow(/empty/i);
  });
});

interface Captured {
  body?: Record<string, unknown>;
  url?: string;
}

/** Mock fal's queue training contract: submit → status → result(diffusers_lora_file). */
function mockTrainFetch(captured: Captured, loraUrl = "https://fal/lora.safetensors"): typeof fetch {
  return (async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const u = String(url);
    if (init?.method === "POST" && !u.includes("/requests/")) {
      captured.body = JSON.parse(String(init.body));
      captured.url = u;
      return new Response(JSON.stringify({ request_id: "train-1" }), { status: 200 });
    }
    if (u.endsWith("/status")) {
      return new Response(JSON.stringify({ status: "COMPLETED" }), { status: 200 });
    }
    if (u.includes("/requests/train-1")) {
      return new Response(
        JSON.stringify({
          diffusers_lora_file: { url: loraUrl, content_type: "application/octet-stream" },
          config_file: { url: "https://fal/config.json" },
        }),
        { status: 200 },
      );
    }
    return new Response(`unexpected ${u}`, { status: 500 });
  }) as typeof fetch;
}

describe("fal trainers", () => {
  it("estimates cost as steps × per-step price", () => {
    expect(falTrainers.flux2.estimateCost({ examples: [], steps: 1000 })).toBeCloseTo(8); // 1000 × $0.008
    expect(falTrainers.flux2.estimateCost({ examples: [] })).toBeCloseTo(8); // default 1000 steps
  });

  it("flux-2 trainer submits the dataset + steps and returns the hosted LoRA url", async () => {
    const captured: Captured = {};
    const out = await falTrainers.flux2.train(
      {
        examples: [{ bytes: await pngBytes("#3344ff"), mime: "image/png", caption: "YUE the moon rabbit" }],
        steps: 1200,
        defaultCaption: "a photo of YUE",
      },
      { apiKey: "k", fetch: mockTrainFetch(captured) },
    );
    expect(captured.url).toContain("fal-ai/flux-2-trainer");
    expect(String(captured.body?.image_data_url)).toMatch(/^data:application\/zip;base64,/);
    expect(captured.body?.steps).toBe(1200);
    expect(captured.body?.default_caption).toBe("a photo of YUE");
    expect(out.loraUrl).toBe("https://fal/lora.safetensors");
    expect(out.configUrl).toBe("https://fal/config.json");
    expect(out.costUsd).toBeCloseTo(1200 * 0.008);
  });

  it("flux-1 fast trainer maps trigger_word + is_style onto its field names", async () => {
    const captured: Captured = {};
    await falTrainers.flux1Fast.train(
      {
        examples: [{ bytes: await pngBytes("#11 cc88".replace(" ", "")), mime: "image/png" }],
        triggerWord: "YUE",
        isStyle: false,
      },
      { apiKey: "k", fetch: mockTrainFetch(captured) },
    );
    expect(captured.url).toContain("fal-ai/flux-lora-fast-training");
    expect(captured.body?.images_data_url).toBeDefined(); // note: plural field name
    expect(captured.body?.trigger_word).toBe("YUE");
    expect(captured.body?.is_style).toBe(false);
  });

  it("throws a clear error when fal returns no weights file", async () => {
    const noFile: typeof fetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (init?.method === "POST" && !u.includes("/requests/"))
        return new Response(JSON.stringify({ request_id: "train-1" }), { status: 200 });
      if (u.endsWith("/status")) return new Response(JSON.stringify({ status: "COMPLETED" }), { status: 200 });
      return new Response(JSON.stringify({}), { status: 200 }); // result without diffusers_lora_file
    }) as typeof fetch;
    await expect(
      falTrainers.flux2.train(
        { examples: [{ bytes: await pngBytes("#000000"), mime: "image/png" }] },
        { apiKey: "k", fetch: noFile },
      ),
    ).rejects.toThrow(/no LoRA weights/i);
  });

  it("requires an API key", async () => {
    await expect(
      falTrainers.flux2.train({ examples: [{ bytes: await pngBytes("#fff"), mime: "image/png" }] }, {}),
    ).rejects.toThrow(/API key/i);
  });
});
