import { falSubmitAndPoll } from "../adapters/fal-queue.js";
import type { ProviderCtx } from "../types.js";
import type { VisionAdapter, VisionInput, VisionProviderCtx, VisionResult } from "./types.js";

/**
 * fal vision adapter over `fal-ai/any-llm/vision` — fal's multi-vendor VLM gateway.
 * Routing vision through fal keeps every model call behind one key (FAL_KEY),
 * consistent with the image-generation and LoRA-training stacks. The underlying VLM
 * is just the `model` slug, so swapping it (or pointing at a stronger model) is a
 * config change, never new code. Reuses the shared fal queue plumbing so timeout /
 * cancel / error semantics match the rest of the fal integration.
 */

/** fal's image-capable any-LLM endpoint. */
export const FAL_VISION_ENDPOINT = "fal-ai/any-llm/vision";
/** Default VLM slug — fast, cheap, strong at structured description. Override per
 *  install via the `FAL_VISION_MODEL` env (wired in the server runtime). */
export const DEFAULT_FAL_VISION_MODEL = "google/gemini-2.5-flash";
const DEFAULT_MAX_TOKENS = 2048;

export interface FalVisionConfig {
  /** Local adapter id, e.g. "fal/vision". */
  id: string;
  displayName: string;
  /** fal any-llm model slug (defaults to `DEFAULT_FAL_VISION_MODEL`). */
  model?: string;
  /** Override the endpoint (rarely needed). */
  endpoint?: string;
  maxTokens?: number;
}

/** Shape of the `any-llm` result payload (only the fields we read). */
interface AnyLlmResult {
  output?: string;
  error?: string | null;
}

/** Encode raw image bytes as a `data:` URI — fal accepts these directly for image_url. */
function toDataUri(bytes: Uint8Array, mime: string): string {
  return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
}

export function createFalVisionModel(config: FalVisionConfig): VisionAdapter {
  const model = config.model?.trim() || DEFAULT_FAL_VISION_MODEL;
  const endpoint = config.endpoint ?? FAL_VISION_ENDPOINT;
  return {
    id: config.id,
    provider: "fal",
    displayName: config.displayName,
    model,

    async describe(input: VisionInput, ctx: VisionProviderCtx): Promise<VisionResult> {
      if (!ctx.apiKey) {
        throw new Error(`Missing fal API key for ${config.id}. Set FAL_KEY in the server env.`);
      }
      const doFetch = ctx.fetch ?? fetch;
      const providerCtx: ProviderCtx = { apiKey: ctx.apiKey, signal: ctx.signal };
      const body: Record<string, unknown> = {
        model,
        prompt: input.prompt,
        image_url: toDataUri(input.image.bytes, input.image.mime),
        max_tokens: input.maxTokens ?? config.maxTokens ?? DEFAULT_MAX_TOKENS,
      };
      if (input.system) body.system_prompt = input.system;

      const result = (await falSubmitAndPoll(doFetch, endpoint, body, providerCtx, {
        label: config.id,
      })) as AnyLlmResult;

      const text = result.output?.trim();
      if (!text) {
        throw new Error(result.error || `Vision model ${config.id} returned an empty response`);
      }
      return { text, model };
    },
  };
}

/** Curated vision models. Add an entry to expose another fal VLM. */
export const falVisionModels = {
  default: createFalVisionModel({ id: "fal/vision", displayName: "fal Vision (any-LLM)" }),
} as const;
