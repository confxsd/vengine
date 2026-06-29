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
  /** fal text-to-image endpoint, e.g. "fal-ai/flux-2-pro" — the exact slug fal routes on. */
  endpoint: string;
  /**
   * Separate fal *edit* endpoint that accepts reference images (e.g.
   * "fal-ai/flux-2-pro/edit"). On fal the base t2i endpoints reject image inputs, so
   * references must go to the edit endpoint. Its presence is what makes the model
   * reference-capable: the adapter routes here (and injects `image_urls`) iff a run
   * actually supplies references, and `consumesReferences` is derived from it — so a
   * model can never advertise references without a real endpoint to apply them.
   */
  editEndpoint?: string;
  /** Cap on reference images the edit endpoint accepts; extras are dropped (with a warning). */
  maxReferences?: number;
  capabilities: Capability[];
  pricing: PricingModel;
  /** Override how NormalizedInput maps to this model's request body (defaults to `defaultMapInput`). */
  mapInput?: (input: NormalizedInput) => Record<string, unknown>;
  /** Set when `mapInput` forwards `NormalizedInput.loras` (see ModelAdapter.consumesLoras). */
  consumesLoras?: boolean;
}

const QUEUE_BASE = "https://queue.fal.run";
const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 180_000;
/**
 * Per-request ceiling for a single fal HTTP call (submit / status poll / result /
 * image download). fal holds its queue connections open and Node's `fetch` has no
 * default timeout, so without this a half-open or stalled socket hangs that one
 * `await` forever — and the `POLL_TIMEOUT_MS` run deadline never fires because it is
 * only checked *between* poll iterations, not during a request. Bounding each request
 * means a stalled connection surfaces as an error (releasing the run) instead of
 * pinning the frame in the generating state indefinitely.
 */
const REQUEST_TIMEOUT_MS = 60_000;
/** fal's multi-image edit field; shared by FLUX.2 edit and Gemini/Nano Banana edit. */
const REFERENCE_FIELD = "image_urls";

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

/** Encode reference bytes as an inline data URI — fal accepts these directly in
 *  image-url fields, so identity/style refs need no separate fal-storage upload. */
function toDataUri(ref: { bytes: Uint8Array; mime: string }): string {
  return `data:${ref.mime};base64,${Buffer.from(ref.bytes).toString("base64")}`;
}

/** Gemini/Nano Banana aspect-ratio enums (label → width/height ratio). */
const GEMINI_ASPECT_RATIOS: ReadonlyArray<readonly [string, number]> = [
  ["1:1", 1], ["2:3", 2 / 3], ["3:2", 3 / 2], ["3:4", 3 / 4], ["4:3", 4 / 3],
  ["4:5", 4 / 5], ["5:4", 5 / 4], ["9:16", 9 / 16], ["16:9", 16 / 9], ["21:9", 21 / 9],
];

/** Nearest supported Gemini aspect-ratio label for a pixel size (log-ratio = scale-invariant). */
function nearestAspectRatio(width: number, height: number): string {
  const target = width / height;
  let best = GEMINI_ASPECT_RATIOS[0]!;
  let bestDiff = Infinity;
  for (const entry of GEMINI_ASPECT_RATIOS) {
    const diff = Math.abs(Math.log(entry[1] / target));
    if (diff < bestDiff) [bestDiff, best] = [diff, entry];
  }
  return best[0];
}

/**
 * `mapInput` for Gemini / Nano Banana, which (unlike FLUX/SDXL) takes **no**
 * `image_size`, steps, guidance or negative prompt — it controls shape via an
 * `aspect_ratio` enum. Mapping pixel dims to the nearest ratio is what keeps a 9:16
 * comic actually 9:16 on this model instead of its default square-ish. `resolution`
 * is deliberately left to the model default (flat-priced per image, and the enum
 * casing varies across fal previews) — set it via `input.extra` if needed.
 */
function geminiMapInput(input: NormalizedInput): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (input.prompt) body.prompt = input.prompt;
  if (input.width && input.height) {
    body.aspect_ratio = nearestAspectRatio(input.width, input.height);
  }
  if (input.seed != null) body.seed = input.seed;
  return { ...body, ...input.extra };
}

/** `mapInput` for fal LoRA endpoints: `defaultMapInput` plus `NormalizedInput.loras`
 *  mapped onto fal's `loras: [{ path, scale }]`. Pair with `consumesLoras: true`. */
function loraMapInput(input: NormalizedInput): Record<string, unknown> {
  const body = defaultMapInput(input);
  if (input.loras?.length) {
    body.loras = input.loras.map((l) => ({ path: l.path, scale: l.scale ?? 1 }));
  }
  return body;
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
 * Issue a fal request with a per-request timeout merged onto the caller's cancel
 * signal: a single stalled request can never hang forever, yet a user "Cancel run"
 * (which aborts `ctx.signal`) still propagates and stops the fetch. A timeout
 * surfaces as a clear error; a cancel propagates as-is so the run reports cancelled.
 */
async function falFetch(
  doFetch: typeof fetch,
  url: string,
  init: RequestInit,
  signal: AbortSignal | undefined,
): Promise<Response> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const merged = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    return await doFetch(url, { ...init, signal: merged });
  } catch (err) {
    if (signal?.aborted) throw err; // user cancel — let it propagate unchanged
    if (timeout.aborted) throw new Error(`fal request timed out after ${REQUEST_TIMEOUT_MS}ms: ${url}`);
    throw err;
  }
}

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
    // Derived, not configured: a model is reference-capable exactly when it has an
    // edit endpoint to apply them. This makes the "advertises references but the
    // endpoint ignores them" bug structurally impossible.
    consumesReferences: !!config.editEndpoint,
    consumesLoras: config.consumesLoras,
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

      // Route to the edit endpoint only when references are actually supplied: the
      // base t2i endpoints reject image inputs, and the edit endpoints *require*
      // `image_urls`, so neither can serve both modes.
      const refs = input.references ?? [];
      const useEdit = !!config.editEndpoint && refs.length > 0;
      const endpoint = useEdit ? config.editEndpoint! : config.endpoint;

      const body = mapInput(input);
      if (useEdit) {
        let chosen = refs;
        if (config.maxReferences && refs.length > config.maxReferences) {
          console.warn(
            `fal ${config.id}: ${refs.length} references exceed the ${config.maxReferences}-image limit; using the first ${config.maxReferences}.`,
          );
          chosen = refs.slice(0, config.maxReferences);
        }
        body[REFERENCE_FIELD] = chosen.map(toDataUri);
      }

      const submitRes = await falFetch(
        doFetch,
        `${QUEUE_BASE}/${endpoint}`,
        { method: "POST", headers, body: JSON.stringify(body) },
        ctx.signal,
      );
      if (!submitRes.ok) {
        throw new Error(`fal submit failed (${submitRes.status}): ${await submitRes.text()}`);
      }
      const submit = (await submitRes.json()) as FalSubmit;
      // Prefer fal's authoritative URLs from the submit response; the fallback
      // mirrors fal's queue scheme (status at `…/requests/{id}/status`, result at
      // the bare `…/requests/{id}`).
      const base = `${QUEUE_BASE}/${endpoint}/requests/${submit.request_id}`;
      const statusUrl = submit.status_url ?? `${base}/status`;
      const responseUrl = submit.response_url ?? base;

      const deadline = Date.now() + POLL_TIMEOUT_MS;
      for (;;) {
        if (ctx.signal?.aborted) throw new Error("fal run aborted");
        if (Date.now() > deadline) throw new Error(`fal run timed out for ${config.id}`);
        const statusRes = await falFetch(doFetch, statusUrl, { headers }, ctx.signal);
        if (!statusRes.ok) {
          throw new Error(`fal status failed (${statusRes.status}): ${await statusRes.text()}`);
        }
        const status = (await statusRes.json()) as FalStatus;
        if (status.status === "COMPLETED") break;
        await sleep(POLL_INTERVAL_MS);
      }

      const resultRes = await falFetch(doFetch, responseUrl, { headers }, ctx.signal);
      if (!resultRes.ok) {
        throw new Error(`fal result failed (${resultRes.status}): ${await resultRes.text()}`);
      }
      const result = (await resultRes.json()) as FalResult;
      const first = result.images?.[0];
      if (!first?.url) throw new Error(`fal returned no image for ${config.id}`);

      const imgRes = await falFetch(doFetch, first.url, {}, ctx.signal);
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
    // Separate edit endpoint carries reference images; preserves identity across
    // multiple subjects — the strongest reference path for comic character anchoring.
    editEndpoint: "fal-ai/gemini-3-pro-image-preview/edit",
    maxReferences: 5,
    capabilities: ["text-to-image", "edit", "reference"],
    mapInput: geminiMapInput,
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
    endpoint: "fal-ai/flux-2-pro",
    // FLUX.2 multi-reference editing (up to 9 images) lives on the /edit endpoint.
    editEndpoint: "fal-ai/flux-2-pro/edit",
    maxReferences: 9,
    capabilities: ["text-to-image", "image-to-image", "edit", "reference"],
    pricing: { kind: "per-image", usd: 0.04 },
  }),
  flux2Lora: createFalModel({
    id: "fal/flux-2-lora",
    displayName: "FLUX.2 [dev] + LoRA",
    endpoint: "fal-ai/flux-2/lora",
    capabilities: ["text-to-image"],
    // Preferred house-style lock: newer and cheaper than FLUX.1 LoRA, and shares the
    // FLUX.2 family look with the flux-2-pro reference/edit path, so style-locked
    // panels and per-shot reference edits stay visually consistent. (Style LoRAs are
    // small; the >2GB fal file-size surcharge only bites on giant merged checkpoints.)
    mapInput: loraMapInput,
    consumesLoras: true,
    pricing: { kind: "per-megapixel", usd: 0.021 },
  }),
  qwenLora: createFalModel({
    id: "fal/qwen-image-lora",
    displayName: "Qwen-Image 2512 + LoRA",
    endpoint: "fal-ai/qwen-image-2512/lora",
    capabilities: ["text-to-image"],
    // Secondary LoRA path: best in-image text rendering (panel captions, signage,
    // SFX lettering) and merges up to 3 LoRAs (style + character + accent).
    mapInput: loraMapInput,
    consumesLoras: true,
    pricing: { kind: "per-megapixel", usd: 0.02 },
  }),
  // Legacy FLUX.1 LoRA — kept for projects pinned to "fal/flux-lora". Strictly
  // dominated by fal/flux-2-lora (older and pricier); prefer that for new work.
  fluxLora: createFalModel({
    id: "fal/flux-lora",
    displayName: "FLUX.1 [dev] + LoRA",
    endpoint: "fal-ai/flux-lora",
    capabilities: ["text-to-image"],
    // Applies trained style/character LoRAs — the strongest lock for a fixed house
    // style (vs reference images, which suit per-shot character identity).
    mapInput: loraMapInput,
    consumesLoras: true,
    pricing: { kind: "per-megapixel", usd: 0.035 },
  }),
} as const;
