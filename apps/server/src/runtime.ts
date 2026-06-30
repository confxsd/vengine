import { Executor, type ExecutionServices, type NodeRegistry } from "@vengine/core";
import {
  ProviderRegistry,
  TextProviderRegistry,
  TrainingRegistry,
  VisionProviderRegistry,
  createFalVisionModel,
  mockModel,
  falModels,
  falTrainers,
  kimiModels,
} from "@vengine/providers";
import { AssetStore, ProjectStore, LibraryStore, FileOutputCache } from "@vengine/storage";
import { createNodeRegistry } from "@vengine/nodes";

/**
 * Singleton engine wiring shared by all routes. Providers, node registry, asset
 * store, and executor are constructed once. API keys are resolved from the
 * server environment only — never accepted from or sent to the client.
 */
export interface Runtime {
  providers: ProviderRegistry;
  /** Text/LLM adapters (prompt assist, intelligence features). */
  textProviders: TextProviderRegistry;
  /** Vision/VLM adapters (scene understanding: image → structured text). */
  visionProviders: VisionProviderRegistry;
  /** LoRA training adapters (character/style fine-tunes). */
  trainers: TrainingRegistry;
  registry: NodeRegistry;
  assets: AssetStore;
  projects: ProjectStore;
  /** Cross-project library: recurring characters, style packs, trained LoRAs. */
  library: LibraryStore;
  executor: Executor;
  services: ExecutionServices;
}

export function createRuntime(): Runtime {
  const providers = new ProviderRegistry()
    .register(mockModel)
    .registerAll(Object.values(falModels));

  // Text models power AI text assist (KIMI_KEY); empty key just disables the feature.
  const textProviders = new TextProviderRegistry().registerAll(Object.values(kimiModels));

  // Vision models power scene understanding (FAL_KEY); the underlying VLM is
  // env-overridable so a stronger model can be swapped in without a code change.
  const visionProviders = new VisionProviderRegistry().register(
    createFalVisionModel({
      id: "fal/vision",
      displayName: "fal Vision (any-LLM)",
      model: process.env.FAL_VISION_MODEL,
    }),
  );

  // LoRA trainers (FAL_KEY); empty key just disables training.
  const trainers = new TrainingRegistry().registerAll(Object.values(falTrainers));

  const registry = createNodeRegistry({ providers });
  const assets = new AssetStore();
  const projects = new ProjectStore();
  const library = new LibraryStore();
  // Persistent cache: unchanged frames stay free across server restarts so an
  // iterative workflow never re-bills a paid model for an image it already made.
  const executor = new Executor({ registry, cache: new FileOutputCache(), concurrency: 4 });

  const services: ExecutionServices = {
    assets,
    getApiKey: (provider) => process.env[`${provider.toUpperCase()}_KEY`],
  };

  return {
    providers,
    textProviders,
    visionProviders,
    trainers,
    registry,
    assets,
    projects,
    library,
    executor,
    services,
  };
}

/** Structural node manifest for the client palette/inspector (no executor logic). */
export function nodeManifest(registry: NodeRegistry) {
  return registry.list().map((def) => ({
    type: def.type,
    title: def.title,
    category: def.category,
    inputs: def.inputs,
    outputs: def.outputs,
  }));
}

export function modelManifest(providers: ProviderRegistry) {
  return providers.list().map((m) => ({
    id: m.id,
    provider: m.provider,
    displayName: m.displayName,
    capabilities: m.capabilities,
    // Whether the adapter actually applies references/LoRAs (drives capability-aware
    // UI warnings: a cast/anchor or LoRA on a model that ignores it is a silent no-op).
    consumesReferences: m.consumesReferences ?? false,
    consumesLoras: m.consumesLoras ?? false,
    pricing: m.pricing,
  }));
}
