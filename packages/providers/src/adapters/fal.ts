import type {
  Capability,
  GeneratedAsset,
  ModelAdapter,
  NormalizedInput,
  PricingModel,
  ProviderCtx,
} from "../types.js";

export interface FalModelConfig {
  /** Local adapter id, e.g. "fal/flux-2-pro". */
  id: string;
  displayName: string;
  /** fal endpoint id, e.g. "fal-ai/flux-2/pro". */
  endpoint: string;
  capabilities: Capability[];
  pricing: PricingModel;
  /** Override how NormalizedInput maps to this model's request body. */
  mapInput?: (input: NormalizedInput) => Record<string, unknown>;
}

const QUEUE_BASE = "https://queue.fal.run";
const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 180_000;

function defaultMapInput(input: NormalizedInput): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (input.prompt) body.prompt = input.prompt;
  if (input.negativePrompt) body.negative_prompt = input.negativePrompt;
  if (input.width && input.height) body.image_size = { width: input.width, height: input.height };
  if (input.steps != null) body.num_inference_steps = input.steps;
  if (input.guidance != null) body.guidance_scale = input.guidance;
  if (input.seed != null) body.seed = input.seed;
  return { ...body, ...input.extra };
}

interface FalSubmit {
  request_id: string;
  status_url?: string;
  response_url?: string;
}
interface FalStatus {
  status: "IN_QUEUE" | "IN_PROGRESS" | "COMPLETED";
}
interface FalResult {
  images?: Array<{ url: string; width?: number; height?: number; content_type?: string }>;
  seed?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Builds a ModelAdapter backed by fal.ai's async queue API: submit → poll →
 * fetch result → download bytes. One config entry per model. Requires
 * `ctx.apiKey`; throws a clear error if missing so the UI can prompt for a key.
 */
export function createFalModel(config: FalModelConfig): ModelAdapter {
  const mapInput = config.mapInput ?? defaultMapInput;
  return {
    id: config.id,
    provider: "fal",
    displayName: config.displayName,
    capabilities: config.capabilities,
    pricing: config.pricing,

    estimateCost(input: NormalizedInput): number {
      if (config.pricing.kind === "per-megapixel") {
        const mp = ((input.width ?? 1024) * (input.height ?? 1024)) / 1_000_000;
        return config.pricing.usd * mp;
      }
      return config.pricing.usd;
    },

    async run(input: NormalizedInput, ctx: ProviderCtx): Promise<GeneratedAsset> {
      if (!ctx.apiKey) {
        throw new Error(`Missing fal API key for model ${config.id}. Set FAL_KEY in the server env.`);
      }
      const doFetch = ctx.fetch ?? fetch;
      const headers = {
        Authorization: `Key ${ctx.apiKey}`,
        "Content-Type": "application/json",
      };

      const submitRes = await doFetch(`${QUEUE_BASE}/${config.endpoint}`, {
        method: "POST",
        headers,
        body: JSON.stringify(mapInput(input)),
        signal: ctx.signal,
      });
      if (!submitRes.ok) {
        throw new Error(`fal submit failed (${submitRes.status}): ${await submitRes.text()}`);
      }
      const submit = (await submitRes.json()) as FalSubmit;
      const base = `${QUEUE_BASE}/${config.endpoint}/requests/${submit.request_id}`;
      const statusUrl = submit.status_url ?? `${base}/status`;
      const responseUrl = submit.response_url ?? base;

      const deadline = Date.now() + POLL_TIMEOUT_MS;
      for (;;) {
        if (ctx.signal?.aborted) throw new Error("fal run aborted");
        if (Date.now() > deadline) throw new Error(`fal run timed out for ${config.id}`);
        const statusRes = await doFetch(statusUrl, { headers, signal: ctx.signal });
        if (!statusRes.ok) {
          throw new Error(`fal status failed (${statusRes.status}): ${await statusRes.text()}`);
        }
        const status = (await statusRes.json()) as FalStatus;
        if (status.status === "COMPLETED") break;
        await sleep(POLL_INTERVAL_MS);
      }

      const resultRes = await doFetch(responseUrl, { headers, signal: ctx.signal });
      if (!resultRes.ok) {
        throw new Error(`fal result failed (${resultRes.status}): ${await resultRes.text()}`);
      }
      const result = (await resultRes.json()) as FalResult;
      const first = result.images?.[0];
      if (!first?.url) throw new Error(`fal returned no image for ${config.id}`);

      const imgRes = await doFetch(first.url, { signal: ctx.signal });
      if (!imgRes.ok) throw new Error(`fal image download failed (${imgRes.status})`);
      const bytes = new Uint8Array(await imgRes.arrayBuffer());

      return {
        bytes,
        mime: first.content_type ?? "image/png",
        width: first.width,
        height: first.height,
        costUsd: this.estimateCost(input),
        seed: result.seed,
      };
    },
  };
}

/** Curated fal models from research (prices indicative, mid-2026). */
export const falModels = {
  nanoBananaPro: createFalModel({
    id: "fal/nano-banana-pro",
    displayName: "Nano Banana Pro (Gemini 3 Pro Image)",
    endpoint: "fal-ai/gemini-3-pro-image-preview",
    capabilities: ["text-to-image", "edit", "reference"],
    pricing: { kind: "per-image", usd: 0.15 },
  }),
  seedream: createFalModel({
    id: "fal/seedream-v4",
    displayName: "Seedream 4.0",
    endpoint: "fal-ai/bytedance/seedream/v4/text-to-image",
    capabilities: ["text-to-image", "image-to-image"],
    pricing: { kind: "per-image", usd: 0.03 },
  }),
  qwenImage: createFalModel({
    id: "fal/qwen-image",
    displayName: "Qwen-Image",
    endpoint: "fal-ai/qwen-image",
    capabilities: ["text-to-image"],
    pricing: { kind: "per-megapixel", usd: 0.02 },
  }),
  zImageTurbo: createFalModel({
    id: "fal/z-image-turbo",
    displayName: "Z-Image Turbo",
    endpoint: "fal-ai/z-image/turbo",
    capabilities: ["text-to-image"],
    pricing: { kind: "per-image", usd: 0.005 },
  }),
  fluxProV2: createFalModel({
    id: "fal/flux-2-pro",
    displayName: "FLUX.2 [pro]",
    endpoint: "fal-ai/flux-2/pro",
    capabilities: ["text-to-image", "image-to-image", "edit"],
    pricing: { kind: "per-image", usd: 0.04 },
  }),
} as const;
