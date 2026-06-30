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

/** One captioned training image for a LoRA fine-tune. */
export interface TrainingExample {
  bytes: Uint8Array;
  mime: string;
  /**
   * Optional caption. Subject (character) trainers auto-caption when absent;
   * style trainers and FLUX.2 use it (or the input's `defaultCaption`) to teach
   * the concept. Best practice: describe everything EXCEPT the identity you want
   * the LoRA to absorb (pose/setting/lighting), so the trigger carries the identity.
   */
  caption?: string;
}

/** Neutral, vendor-agnostic LoRA-training input. Adapters map this to their API. */
export interface TrainingInput {
  /** The dataset. fal trainers want ~10–30 for a character, more for a style. */
  examples: TrainingExample[];
  /** Total training steps (cost is per-step). Adapter supplies a sane default. */
  steps?: number;
  /**
   * Whether this teaches a STYLE (`true`) or a SUBJECT/character (`false`/omitted).
   * Subject trainers segment + auto-caption the subject; style trainers disable that
   * and lean on captions. Mirrors fal's `is_style`.
   */
  isStyle?: boolean;
  /** A unique token that activates the LoRA at inference (e.g. "YUE"). FLUX.1 trainer. */
  triggerWord?: string;
  /** Caption used for images lacking their own; the concept anchor for FLUX.2's trainer. */
  defaultCaption?: string;
  /** Override the trainer's default learning rate (advanced). */
  learningRate?: number;
}

/** The product of a successful train: a hosted LoRA file ready for inference. */
export interface TrainedLoraResult {
  /** URL of the trained weights — drops straight into `LoraInput.path`. */
  loraUrl: string;
  /** URL of the training config fal emits alongside the weights (provenance). */
  configUrl?: string;
  /** Actual USD cost of the training run (estimate if the vendor doesn't report it). */
  costUsd: number;
}

/**
 * A durable, persistable handle to a submitted training job. It carries only what's
 * needed to *resume* watching the job after a process restart — the vendor job id,
 * its endpoint, and the step count (for cost). The server persists this so a long
 * train survives client disconnects and server restarts: fal keeps running the job,
 * and we re-attach a poll loop from the stored handle. No live socket required.
 */
export interface TrainingHandle {
  /** Vendor job id (fal `request_id`). */
  jobId: string;
  /** Vendor endpoint the job runs on (provenance / display). */
  endpoint: string;
  /** Steps the job was submitted with (for cost on completion). */
  steps: number;
  /** Authoritative status-poll URL (captured at submit; persisted for resume). */
  statusUrl: string;
  /** Authoritative result URL (captured at submit; persisted for resume). */
  responseUrl: string;
}

/** One poll of a training job: still running, finished, or failed. The status
 *  strings mirror `@vengine/shared` `TrainingStatus` (providers has no dep on shared,
 *  so they're re-declared here — keep the two in sync if a state is ever added). */
export interface TrainingPoll {
  status: "training" | "ready" | "failed";
  /** Present iff `status === "ready"`. */
  result?: TrainedLoraResult;
  /** Present iff `status === "failed"`. */
  error?: string;
}

/**
 * A LoRA *trainer*. Sibling to `ModelAdapter`: the shape is (captioned images →
 * hosted weights file) instead of (prompt → image). Deliberately **two-phase** —
 * `submit` (durable, returns a persistable handle) + `poll` (resumable from that
 * handle) — so a job's lifecycle can be owned by the server and outlive any HTTP
 * request, not bound to a single long-held connection. `train` composes them for
 * callers/tests that don't need durability. The `loraUrl` output feeds back into
 * generation via `LoraInput.path`, so a trained character/style runs on the existing
 * LoRA-capable inference adapters unchanged.
 */
export interface TrainingAdapter {
  /** Stable unique id, "<provider>/<trainer>", e.g. "fal/flux-2-trainer". */
  id: string;
  provider: string;
  displayName: string;
  /**
   * The inference model id this trainer's output is compatible with (e.g.
   * "fal/flux-2-lora"). A FLUX.2 LoRA only runs on FLUX.2; surfacing this lets the
   * UI steer the user to a model that can actually apply what they trained.
   */
  baseModelId: string;
  /** What this trainer is good at — drives the picker copy. */
  trains: "subject" | "style" | "both";
  /** USD per training step — the single source of truth for cost (the UI reads this
   *  from the trainer manifest instead of hardcoding its own price table). */
  pricePerStep: number;
  /** Cheap, no-network cost estimate (steps × per-step price). */
  estimateCost(input: TrainingInput): number;
  /** Build the dataset + submit the job; resolve to a durable, persistable handle. */
  submit(input: TrainingInput, ctx: ProviderCtx): Promise<TrainingHandle>;
  /** Poll a submitted job (resumable from a persisted handle). */
  poll(handle: TrainingHandle, ctx: ProviderCtx): Promise<TrainingPoll>;
  /** Convenience: `submit` then poll to completion. For non-durable callers/tests. */
  train(
    input: TrainingInput,
    ctx: ProviderCtx,
    onStatus?: (status: string) => void,
  ): Promise<TrainedLoraResult>;
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
  /**
   * Hard cap on reference images the vendor edit endpoint accepts; the adapter
   * truncates extras (tail-first) with a warning. Surfaced on the public adapter so
   * capability-aware UI can warn *before* a run silently drops a cast/style sheet.
   * Undefined = no enforced cap.
   */
  maxReferences?: number;
  /** Cheap, no-network cost estimate used by the planner's dry-run. */
  estimateCost(input: NormalizedInput): number;
  /** Submit + resolve to a finished asset, hiding async/polling/webhooks. */
  run(input: NormalizedInput, ctx: ProviderCtx): Promise<GeneratedAsset>;
}
