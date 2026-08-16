import { isWorkerRuntime } from "@vengine/shared";
import type { GeneratedAsset, ModelAdapter, NormalizedInput } from "../types.js";

/** sharp is native (libvips) — resolved at runtime, kept out of worker bundles. */
async function loadSharp(): Promise<typeof import("sharp")> {
  const specifier = "sharp";
  const mod = (await import(specifier)) as { default?: typeof import("sharp") };
  return mod.default ?? (mod as unknown as typeof import("sharp"));
}

/** Tiny deterministic string hash (djb2) → used to pick colors from the prompt. */
function hash(str: string): number {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h;
}

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) =>
    c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === "&" ? "&amp;" : c === "'" ? "&apos;" : "&quot;",
  );
}

/**
 * Offline mock generation model. Deterministically synthesizes a gradient PNG from
 * (prompt, seed) so the full pipeline runs end-to-end with no API key. Same inputs
 * ⇒ same bytes, which exercises the engine's content-addressed cache realistically.
 */
export const mockModel: ModelAdapter = {
  id: "mock/gradient",
  provider: "mock",
  displayName: "Mock Gradient (offline)",
  capabilities: ["text-to-image"],
  pricing: { kind: "per-image", usd: 0.002 },

  estimateCost(input: NormalizedInput): number {
    return input.quality === "preview" ? this.pricing.usd * 0.25 : this.pricing.usd;
  },

  async run(input: NormalizedInput): Promise<GeneratedAsset> {
    const prompt = input.prompt ?? "";
    const seed = input.seed ?? hash(prompt);
    const preview = input.quality === "preview";
    const width = input.width ?? (preview ? 256 : 768);
    const height = input.height ?? (preview ? 256 : 768);

    const h1 = hash(prompt + ":" + seed) % 360;
    const h2 = (h1 + 60 + (seed % 120)) % 360;
    const label = escapeXml(prompt.slice(0, 48) || "untitled");

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="hsl(${h1},70%,55%)"/>
        <stop offset="100%" stop-color="hsl(${h2},70%,35%)"/>
      </linearGradient></defs>
      <rect width="100%" height="100%" fill="url(#g)"/>
      <text x="50%" y="50%" font-family="sans-serif" font-size="${Math.round(width / 18)}"
        fill="rgba(255,255,255,0.92)" text-anchor="middle" dominant-baseline="middle">${label}</text>
    </svg>`;

    // On Workers sharp can't run, so serve the SVG directly — same visual, no
    // native dependency. The default comic model is mock, so this keeps the
    // deployed app usable offline (zero fal spend).
    if (isWorkerRuntime()) {
      return {
        bytes: new TextEncoder().encode(svg),
        mime: "image/svg+xml",
        width,
        height,
        costUsd: this.estimateCost(input),
        seed,
      };
    }
    const sharp = await loadSharp();
    const png = await sharp(Buffer.from(svg)).png().toBuffer();

    return {
      bytes: new Uint8Array(png),
      mime: "image/png",
      width,
      height,
      costUsd: this.estimateCost(input),
      seed,
    };
  },
};
