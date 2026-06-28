/**
 * The provider abstraction. Every model integration implements `ModelAdapter`,
 * which normalizes a neutral input, hides sync-vs-async/webhook execution, and
 * reports a normalized cost. Adding a vendor = adding an adapter; the engine,
 * nodes, and UI never change.
 */

export type Capability =
  | "text-to-image"
  | "image-to-image"
  | "inpaint"
  | "upscale"
  | "bg-remove"
  | "reference"
  | "edit";

/** Normalizes the three billing shapes seen across vendors into one estimator. */
export interface PricingModel {
  kind: "per-image" | "per-megapixel" | "per-second" | "flat";
  /** USD per unit (per image, per megapixel, per second, or flat per call). */
  usd: number;
}

export interface ImageBytes {
  bytes: Uint8Array;
  mime: string;
  width?: number;
  height?: number;
}

/** A reference image for identity/style consistency. */
export interface ReferenceInput extends ImageBytes {
  /** 0..1 influence weight, if the model supports it. */
  weight?: number;
}

/** A hosted LoRA adapter to apply during generation (trained style/character). */
export interface LoraInput {
  /** URL or hub id of the weights (a CivitAI/HF `.safetensors` URL, or fal-hosted path). */
  path: string;
  /** Influence scale (typically ~0–1.5; 1 = full strength). */
  scale?: number;
}

/** Neutral, vendor-agnostic generation input. Adapters map this to their API. */
export interface NormalizedInput {
  prompt?: string;
  negativePrompt?: string;
  width?: number;
  height?: number;
  steps?: number;
  guidance?: number;
  seed?: number;
  /** Source image for image-to-image / edit / inpaint. */
  image?: ImageBytes;
  /** Mask for inpainting (white = edit region). */
  mask?: ImageBytes;
  /** Reference images for consistency (character/style). */
  references?: ReferenceInput[];
  /** Hosted LoRAs to apply (trained style/character), for models that support them. */
  loras?: LoraInput[];
  /** Cheap/fast path when "preview". */
  quality?: "preview" | "final";
  /** Escape hatch for model-specific params not covered above. */
  extra?: Record<string, unknown>;
}

export interface GeneratedAsset {
  bytes: Uint8Array;
  mime: string;
  width?: number;
  height?: number;
  /** Actual USD cost of this call (estimate if the vendor doesn't report it). */
  costUsd: number;
  /** The seed actually used (vendors may assign one when omitted). */
  seed?: number;
}

export interface ProviderCtx {
  /** Injected for testability; defaults to global fetch. */
  fetch?: typeof fetch;
  signal?: AbortSignal;
  /** Resolved per-provider API key (never sourced from the client). */
  apiKey?: string;
}

export interface ModelAdapter {
  /** Stable unique id, "<provider>/<model>", e.g. "fal/flux-2-pro". */
  id: string;
  provider: string;
  displayName: string;
  capabilities: Capability[];
  pricing: PricingModel;
  /**
   * True only when `run` actually maps `NormalizedInput.references` onto the
   * vendor request. Distinct from the `"reference"` *capability* (which advertises
   * model support): the adapter may not yet implement the wiring. Consumers gate
   * on this so passing a reference image to an adapter that ignores it does not
   * pointlessly bust the content-addressed cache (and re-bill) for identical output.
   */
  consumesReferences?: boolean;
  /**
   * True only when `run` actually maps `NormalizedInput.loras` onto the vendor
   * request. Same contract as `consumesReferences`: the generation node drops
   * `loras` from the cache key on models that ignore them, so toggling a LoRA on a
   * non-LoRA model is a cache hit, not a wasted re-bill.
   */
  consumesLoras?: boolean;
  /** Cheap, no-network cost estimate used by the planner's dry-run. */
  estimateCost(input: NormalizedInput): number;
  /** Submit + resolve to a finished asset, hiding async/polling/webhooks. */
  run(input: NormalizedInput, ctx: ProviderCtx): Promise<GeneratedAsset>;
}
