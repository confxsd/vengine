export * from "./types.js";
export * from "./registry.js";
export { mockModel } from "./adapters/mock.js";
export { createFalModel, falModels, type FalModelConfig } from "./adapters/fal.js";

// Text/LLM layer (prompt assist, intelligence features).
export * from "./text/types.js";
export { TextProviderRegistry } from "./text/registry.js";
export {
  createKimiModel,
  kimiModels,
  KIMI_BASE_URL,
  DEFAULT_KIMI_MODEL,
  type KimiModelConfig,
} from "./text/kimi.js";
