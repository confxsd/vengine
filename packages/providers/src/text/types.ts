/**
 * The text/LLM provider abstraction — the textual counterpart to the image
 * `ModelAdapter`. Every chat-completion vendor (DeepSeek, and later
 * Claude/OpenAI/etc.) implements `TextAdapter`, normalizing a neutral message
 * list and hiding each API's request/response shape. Adding a vendor = adding an
 * adapter; the assist routes and the UI never change.
 */

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

/** Neutral, vendor-agnostic completion input. Adapters map this to their API. */
export interface TextCompletionInput {
  messages: ChatMessage[];
  /** 0..2 sampling temperature; falls back to the adapter's configured default. */
  temperature?: number;
  /** Cap on generated tokens; falls back to the adapter's configured default. */
  maxTokens?: number;
}

export interface TextCompletionResult {
  /** The assistant's reply text (trimmed). */
  text: string;
  /** The remote model id that produced it (for display/telemetry). */
  model: string;
}

export interface TextProviderCtx {
  /** Injected for testability; defaults to global fetch. */
  fetch?: typeof fetch;
  signal?: AbortSignal;
  /** Resolved per-provider API key (never sourced from the client). */
  apiKey?: string;
}

export interface TextAdapter {
  /** Stable unique id, "<provider>/<model>", e.g. "deepseek/chat". */
  id: string;
  /** Provider key; the env var is `${provider.toUpperCase()}_KEY` (e.g. DEEPSEEK_KEY). */
  provider: string;
  displayName: string;
  /** The remote model identifier sent to the vendor. */
  model: string;
  /** Submit + resolve a chat completion, hiding the vendor's wire format. */
  complete(input: TextCompletionInput, ctx: TextProviderCtx): Promise<TextCompletionResult>;
}
