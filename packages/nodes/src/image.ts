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
   * Asset hashes of reference images for identity/style consistency (e.g. a comic's
   * style anchor). Stored in params so they fold into the content-addressed cache
   * key: the same anchor hits cache, a changed/removed anchor invalidates correctly.
   */
  referenceHashes: z.array(z.string().length(64)).optional(),
  /** 0..1 influence weight applied to every reference, if the model supports it. */
  referenceWeight: z.number().min(0).max(1).optional(),
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
    quality,
  };
}

/** Load reference images from the asset store into provider ReferenceInputs. */
async function loadReferences(
  assets: AssetStore,
  hashes: string[] | undefined,
  weight: number | undefined,
): Promise<ReferenceInput[]> {
  if (!hashes?.length) return [];
  return Promise.all(
    hashes.map(async (hash) => {
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
      if (model?.consumesReferences) return params;
      const { referenceHashes: _h, referenceWeight: _w, ...rest } = params;
      return rest;
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
        ? await loadReferences(ctx.services.assets, params.referenceHashes, params.referenceWeight)
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
