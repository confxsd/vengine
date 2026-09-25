import type {
  TextAdapter,
  TextCompletionInput,
  TextCompletionResult,
  TextProviderCtx,
} from "./types.js";

/**
 * OpenAI-compatible chat-completion adapter. DeepSeek (and OpenRouter, see
 * `openrouter.ts`) expose the same `/chat/completions` wire shape, so one
 * config-driven mapping serves both: one `DeepSeekModelConfig` entry per model,
 * with `provider` naming whose `${PROVIDER}_KEY` env var authenticates it.
 * Requires `ctx.apiKey` (resolved server-side); throws a clear error if missing
 * so the UI can prompt.
 */

export const DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1";
/** DeepSeek-V3 chat model — strong instruction-following, good for prompt-craft. */
export const DEFAULT_DEEPSEEK_MODEL = "deepseek-chat";
const DEFAULT_TEMPERATURE = 0.6;
const DEFAULT_MAX_TOKENS = 4096;

export interface DeepSeekModelConfig {
  /** Local adapter id, e.g. "deepseek/chat". */
  id: string;
  displayName: string;
  /**
   * Provider key naming the env var that holds the API key
   * (`${provider.toUpperCase()}_KEY`). Defaults to "deepseek"; OpenRouter entries
   * pass "openrouter" so they resolve `OPENROUTER_KEY`.
   */
  provider?: string;
  /** Remote model id (defaults to `DEFAULT_DEEPSEEK_MODEL`). */
  model?: string;
  /** Override the API base. */
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
  /**
   * Extra fields merged verbatim into the request body — the escape hatch for
   * vendor-specific knobs (e.g. OpenRouter's `reasoning`) without widening the
   * neutral `TextCompletionInput` contract.
   */
  extraBody?: Record<string, unknown>;
}

/** Shape of DeepSeek's OpenAI-compatible chat-completion response. */
interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  error?: { message?: string };
}

export function createDeepSeekModel(config: DeepSeekModelConfig): TextAdapter {
  const model = config.model ?? DEFAULT_DEEPSEEK_MODEL;
  const baseUrl = (config.baseUrl ?? DEEPSEEK_BASE_URL).replace(/\/+$/, "");
  const provider = config.provider ?? "deepseek";
  return {
    id: config.id,
    provider,
    displayName: config.displayName,
    model,

    async complete(input: TextCompletionInput, ctx: TextProviderCtx): Promise<TextCompletionResult> {
      if (!ctx.apiKey) {
        throw new Error(
          `Missing ${provider} API key for ${config.id}. Set ${provider.toUpperCase()}_KEY in the server env.`,
        );
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
          ...config.extraBody,
        }),
        signal: ctx.signal,
      });
      if (!res.ok) {
        throw new Error(`${provider} request failed (${res.status}): ${await res.text()}`);
      }
      const data = (await res.json()) as ChatCompletionResponse;
      const text = data.choices?.[0]?.message?.content?.trim();
      if (!text) {
        if (data.error?.message) throw new Error(data.error.message);
        if (data.choices?.[0]?.finish_reason === "length") {
          // Reasoning-style models bill their hidden thinking tokens against
          // max_tokens; when those eat the whole cap, the answer is empty.
          throw new Error(
            `${provider} exhausted max_tokens before emitting any content for ${config.id} ` +
              `(finish_reason "length" — reasoning tokens consumed the completion budget). ` +
              `Raise maxTokens or disable reasoning for this model.`,
          );
        }
        throw new Error(`${provider} returned an empty response for ${config.id}`);
      }
      return { text, model };
    },
  };
}

/** Curated DeepSeek models. Add an entry to expose another DeepSeek model. */
export const deepseekModels = {
  chat: createDeepSeekModel({ id: "deepseek/chat", displayName: "DeepSeek Chat (V3)" }),
} as const;
