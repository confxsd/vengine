import { createDeepSeekModel } from "./deepseek.js";

/**
 * OpenRouter text models. OpenRouter exposes the same OpenAI-compatible
 * `/chat/completions` wire shape as DeepSeek (see `deepseek.ts` — one shared
 * adapter, `provider: "openrouter"` so the key resolves from `OPENROUTER_KEY`),
 * with vendor model slugs like "z-ai/glm-5.3-flash". The vengine text features
 * (draft parsing, director chat, prompt assist) default to the GLM entry here.
 */

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/** Curated OpenRouter models. Add an entry to expose another OpenRouter model. */
export const openrouterModels = {
  glm: createDeepSeekModel({
    id: "openrouter/glm-5.3-flash",
    provider: "openrouter",
    displayName: "GLM 5.3 Flash (OpenRouter)",
    baseUrl: OPENROUTER_BASE_URL,
    model: "z-ai/glm-5.3-flash",
  }),
} as const;
