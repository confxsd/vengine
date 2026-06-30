import type {
  TextAdapter,
  TextCompletionInput,
  TextCompletionResult,
  TextProviderCtx,
} from "./types.js";

/**
 * DeepSeek text adapter. DeepSeek exposes an OpenAI-compatible
 * `/chat/completions` endpoint, so this adapter is a thin, config-driven mapping:
 * one `DeepSeekModelConfig` entry per model. Requires `ctx.apiKey` (resolved from
 * `DEEPSEEK_KEY` server-side); throws a clear error if missing so the UI can prompt.
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
  /** Remote model id (defaults to `DEFAULT_DEEPSEEK_MODEL`). */
  model?: string;
  /** Override the API base. */
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
}

/** Shape of DeepSeek's OpenAI-compatible chat-completion response. */
interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
}

export function createDeepSeekModel(config: DeepSeekModelConfig): TextAdapter {
  const model = config.model ?? DEFAULT_DEEPSEEK_MODEL;
  const baseUrl = (config.baseUrl ?? DEEPSEEK_BASE_URL).replace(/\/+$/, "");
  return {
    id: config.id,
    provider: "deepseek",
    displayName: config.displayName,
    model,

    async complete(input: TextCompletionInput, ctx: TextProviderCtx): Promise<TextCompletionResult> {
      if (!ctx.apiKey) {
        throw new Error(`Missing DeepSeek API key for ${config.id}. Set DEEPSEEK_KEY in the server env.`);
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
        throw new Error(`DeepSeek request failed (${res.status}): ${await res.text()}`);
      }
      const data = (await res.json()) as ChatCompletionResponse;
      const text = data.choices?.[0]?.message?.content?.trim();
      if (!text) {
        throw new Error(data.error?.message ?? `DeepSeek returned an empty response for ${config.id}`);
      }
      return { text, model };
    },
  };
}

/** Curated DeepSeek models. Add an entry to expose another DeepSeek model. */
export const deepseekModels = {
  chat: createDeepSeekModel({ id: "deepseek/chat", displayName: "DeepSeek Chat (V3)" }),
} as const;
