import type {
  TextAdapter,
  TextCompletionInput,
  TextCompletionResult,
  TextProviderCtx,
} from "./types.js";

/**
 * Kimi (Moonshot AI) text adapter. Moonshot exposes an OpenAI-compatible
 * `/chat/completions` endpoint, so this adapter is a thin, config-driven mapping:
 * one `KimiModelConfig` entry per model. Requires `ctx.apiKey` (resolved from
 * `KIMI_KEY` server-side); throws a clear error if missing so the UI can prompt.
 */

/** International Moonshot base; use `.cn` for the mainland endpoint via `baseUrl`. */
export const KIMI_BASE_URL = "https://api.moonshot.ai/v1";
/** Flagship Kimi K2 model (strong instruction-following — good for prompt-craft). */
export const DEFAULT_KIMI_MODEL = "kimi-k2.6";
const DEFAULT_TEMPERATURE = 0.6;
// Generous budget: K2.x are reasoning models that spend tokens on hidden
// `reasoning_content` *before* the answer, so a small cap can starve the reply.
const DEFAULT_MAX_TOKENS = 4096;

export interface KimiModelConfig {
  /** Local adapter id, e.g. "kimi/k2". */
  id: string;
  displayName: string;
  /** Remote model id (defaults to `DEFAULT_KIMI_MODEL`). */
  model?: string;
  /** Override the API base (e.g. the mainland `https://api.moonshot.cn/v1`). */
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
}

/** Shape of Moonshot's OpenAI-compatible chat-completion response. */
interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
}

export function createKimiModel(config: KimiModelConfig): TextAdapter {
  const model = config.model ?? DEFAULT_KIMI_MODEL;
  const baseUrl = (config.baseUrl ?? KIMI_BASE_URL).replace(/\/+$/, "");
  return {
    id: config.id,
    provider: "kimi",
    displayName: config.displayName,
    model,

    async complete(input: TextCompletionInput, ctx: TextProviderCtx): Promise<TextCompletionResult> {
      if (!ctx.apiKey) {
        throw new Error(`Missing Kimi API key for ${config.id}. Set KIMI_KEY in the server env.`);
      }
      const doFetch = ctx.fetch ?? fetch;
      const res = await doFetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ctx.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: input.messages,
          temperature: input.temperature ?? config.temperature ?? DEFAULT_TEMPERATURE,
          max_tokens: input.maxTokens ?? config.maxTokens ?? DEFAULT_MAX_TOKENS,
        }),
        signal: ctx.signal,
      });
      if (!res.ok) {
        throw new Error(`Kimi request failed (${res.status}): ${await res.text()}`);
      }
      const data = (await res.json()) as ChatCompletionResponse;
      const text = data.choices?.[0]?.message?.content?.trim();
      if (!text) {
        throw new Error(data.error?.message ?? `Kimi returned an empty response for ${config.id}`);
      }
      return { text, model };
    },
  };
}

/** Curated Kimi models. Add an entry to expose another Moonshot model. */
export const kimiModels = {
  // k2.6 is a reasoning model: it returns reasoning in a separate `reasoning_content`
  // field (ignored here — `content` is the clean answer) and only accepts temperature 1.
  k2: createKimiModel({ id: "kimi/k2", displayName: "Kimi K2 (Moonshot)", temperature: 1 }),
} as const;
