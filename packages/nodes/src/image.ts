import { z } from "zod";
import type { NodeDefinition, RenderQuality } from "@vengine/core";
import type { AssetRef } from "@vengine/shared";
import type { ReferenceInput, NormalizedInput, ProviderRegistry } from "@vengine/providers";
import type { AssetStore } from "@vengine/storage";
import "./services.js";

export const TextToImageParams = z.object({
  model: z.string().default("mock/gradient"),
  prompt: z.string().default(""),
  negativePrompt: z.string().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  steps: z.number().int().positive().optional(),
  guidance: z.number().optional(),
  seed: z.number().int().optional(),
  /**
   * Weighted reference images for identity/style consistency (e.g. a comic's style
   * anchors + cast). Each carries its own 0..1 influence weight. Ordered — models
   * weight earlier references more — and folded into the content-addressed cache key
   * so a changed/reordered/reweighted set invalidates correctly. Preferred over the
   * legacy `referenceHashes`/`referenceWeight` pair below.
   */
  references: z
    .array(z.object({ hash: z.string().length(64), weight: z.number().min(0).max(1).optional() }))
    .optional(),
  /**
   * @deprecated Flat reference hashes with a single shared `referenceWeight`. Kept
   * for direct graph users; the comic compiler now emits `references`. When both are
   * present, `references` wins.
   */
  referenceHashes: z.array(z.string().length(64)).optional(),
  /** @deprecated 0..1 influence weight applied to every `referenceHashes` entry. */
  referenceWeight: z.number().min(0).max(1).optional(),
  /**
   * Hosted LoRAs (trained style/character) applied by LoRA-capable models. Part of
   * params so they fold into the cache key — but the node drops them for models that
   * don't `consumesLoras`, so toggling a LoRA on a non-LoRA model stays a cache hit.
   */
  loras: z
    .array(z.object({ path: z.string().min(1), scale: z.number().optional() }))
    .optional(),
});
export type TextToImageParams = z.infer<typeof TextToImageParams>;

function toInput(p: TextToImageParams, quality: RenderQuality): NormalizedInput {
  return {
    prompt: p.prompt,
    negativePrompt: p.negativePrompt,
    width: p.width,
    height: p.height,
    steps: p.steps,
    guidance: p.guidance,
    seed: p.seed,
    loras: p.loras,
    quality,
  };
}

/** A reference to load: an asset hash plus its optional per-image influence weight. */
interface RefSpec {
  hash: string;
  weight?: number;
}

/**
 * Resolve the effective reference specs from params: the weighted `references` list
 * if present, else the legacy flat `referenceHashes` with the single shared weight.
 * One place so `execute` and `cacheKeyParams` agree on precedence.
 */
function resolveRefSpecs(params: TextToImageParams): RefSpec[] {
  if (params.references?.length) return params.references;
  return (params.referenceHashes ?? []).map((hash) => ({ hash, weight: params.referenceWeight }));
}

/** Load reference images from the asset store into provider ReferenceInputs. */
async function loadReferences(
  assets: AssetStore,
  specs: RefSpec[],
): Promise<ReferenceInput[]> {
  if (!specs.length) return [];
  return Promise.all(
    specs.map(async ({ hash, weight }) => {
      const [buf, meta] = await Promise.all([assets.get(hash), assets.getMeta(hash)]);
      return {
        bytes: new Uint8Array(buf),
        mime: meta.mime,
        width: meta.width,
        height: meta.height,
        weight,
      } satisfies ReferenceInput;
    }),
  );
}

/**
 * Text-to-image generation node. Resolves its model from the provider registry,
 * runs it, stores the result in the content-addressed asset store, and emits a
 * preview + cost event. `qualitySensitive` so preview/final never collide in cache.
 */
export function createTextToImageNode(
  providers: ProviderRegistry,
): NodeDefinition<TextToImageParams> {
  return {
    type: "generate.text-to-image",
    category: "generation",
    title: "Text to Image",
    qualitySensitive: true,
    inputs: [],
    outputs: [{ id: "image", type: "image", label: "Image" }],
    paramsSchema: TextToImageParams,

    // Reference hashes only affect output for adapters that actually consume them.
    // Drop them from the cache key otherwise, so toggling a style anchor on a model
    // that ignores references is a cache hit (no wasted re-bill for identical bytes).
    cacheKeyParams(params) {
      const model = providers.get(params.model);
      let p: TextToImageParams = params;
      if (!model?.consumesReferences) {
        const { references: _r, referenceHashes: _h, referenceWeight: _w, ...rest } = p;
        p = rest;
      }
      if (!model?.consumesLoras && p.loras) {
        const { loras: _l, ...rest } = p;
        p = rest;
      }
      return p;
    },

    estimateCost({ params, quality }) {
      const model = providers.get(params.model);
      return model ? model.estimateCost(toInput(params, quality)) : 0;
    },

    async execute({ nodeId, params, ctx, signal }) {
      const model = providers.require(params.model);
      const apiKey = ctx.services.getApiKey?.(model.provider);
      // Skip the asset reads entirely when the adapter won't use references.
      const references = model.consumesReferences
        ? await loadReferences(ctx.services.assets, resolveRefSpecs(params))
        : [];
      const input = { ...toInput(params, ctx.quality), ...(references.length ? { references } : {}) };
      const asset = await model.run(input, { apiKey, signal });
      const ref: AssetRef = await ctx.services.assets.put(asset.bytes, asset.mime);
      ctx.emit({
        runId: ctx.runId,
        nodeId,
        status: "running",
        previewHash: ref.hash,
        cost: asset.costUsd,
        at: new Date().toISOString(),
      });
      return { image: ref };
    },
  };
}
