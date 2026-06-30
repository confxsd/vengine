export * from "./types.js";
export * from "./registry.js";
export { mockModel } from "./adapters/mock.js";
export { createFalModel, falModels, type FalModelConfig } from "./adapters/fal.js";
export {
  createFalTrainer,
  falTrainers,
  type FalTrainerConfig,
} from "./adapters/fal-training.js";
export { buildDatasetDataUri } from "./adapters/dataset.js";
export { FalHttpError } from "./adapters/fal-queue.js";
export {
  analyzeSheet,
  cropRegion,
  cropPreview,
  segmentRegions,
  clampBox,
  type Box,
  type SheetRegion,
} from "./adapters/sheet.js";

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

// Vision layer (scene understanding: image → structured text).
export * from "./vision/types.js";
export { VisionProviderRegistry } from "./vision/registry.js";
export {
  createFalVisionModel,
  falVisionModels,
  FAL_VISION_ENDPOINT,
  DEFAULT_FAL_VISION_MODEL,
  type FalVisionConfig,
} from "./vision/fal-vision.js";
