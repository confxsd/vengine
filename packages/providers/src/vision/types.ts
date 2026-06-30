import type { ImageBytes } from "../types.js";

/**
 * The **vision** provider abstraction — the image→text counterpart to the image
 * `ModelAdapter` and the text `TextAdapter`. A vision model reads one image plus an
 * instruction and returns text (a description, a structured breakdown as JSON, an
 * answer). Every vendor (fal's hosted VLMs first; Claude/OpenAI later) implements
 * `VisionAdapter`, so the scene routes and the UI never change when a vendor is
 * swapped — it's one more adapter behind one registry.
 */

export interface VisionInput {
  /** The image to read (raw bytes + mime; an adapter base64-encodes as needed). */
  image: ImageBytes;
  /** The instruction — what to extract from the image. */
  prompt: string;
  /** Optional system prompt to set role/output rules (e.g. "return JSON only"). */
  system?: string;
  /** Cap on generated tokens; falls back to the adapter's configured default. */
  maxTokens?: number;
}

export interface VisionResult {
  /** The model's reply text (trimmed). For structured use, callers parse JSON out. */
  text: string;
  /** The remote model id that produced it (for display/telemetry). */
  model: string;
}

export interface VisionProviderCtx {
  /** Injected for testability; defaults to global fetch. */
  fetch?: typeof fetch;
  signal?: AbortSignal;
  /** Resolved per-provider API key (never sourced from the client). */
  apiKey?: string;
}

export interface VisionAdapter {
  /** Stable unique id, "<provider>/<model>", e.g. "fal/vision". */
  id: string;
  /** Provider key; the env var is `${provider.toUpperCase()}_KEY` (e.g. FAL_KEY). */
  provider: string;
  displayName: string;
  /** The remote model identifier sent to the vendor. */
  model: string;
  /** Read the image + instruction → text, hiding the vendor's wire format. */
  describe(input: VisionInput, ctx: VisionProviderCtx): Promise<VisionResult>;
}
