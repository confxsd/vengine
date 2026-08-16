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
  deepseekModels,
} from "@vengine/providers";
import {
  R2AssetStore,
  D1ProjectStore,
  D1LibraryStore,
  D1OutputCache,
  type D1Like,
  type R2BucketLike,
} from "@vengine/storage/worker";
import { createNodeRegistry } from "@vengine/nodes";
import type { Runtime } from "../../server/src/runtime.js";

export type { Runtime };

/** Worker secret/vars shape (satisfied by the full `Env` binding type). */
export interface WorkerEnv {
  FAL_KEY?: string;
  DEEPSEEK_KEY?: string;
  FAL_VISION_MODEL?: string;
}

/**
 * Builds the engine wiring for the Worker. Constructed per request / per
 * Durable Object wake — registries are cheap, and no cross-request state is
 * kept (the D1 stores are optimistic-locking, so isolates can share safely).
 *
 * API keys come only from Worker secrets (`FAL_KEY`, `DEEPSEEK_KEY`) — never
 * from the client.
 */
export function createRuntime(opts: {
  db: D1Like;
  media: R2BucketLike;
  env: WorkerEnv;
}): Runtime {
  const providers = new ProviderRegistry()
    .register(mockModel)
    .registerAll(Object.values(falModels));

  const textProviders = new TextProviderRegistry().registerAll(Object.values(deepseekModels));

  const visionProviders = new VisionProviderRegistry().register(
    createFalVisionModel({
      id: "fal/vision",
      displayName: "fal Vision (any-LLM)",
      model: opts.env.FAL_VISION_MODEL,
    }),
  );

  const trainers = new TrainingRegistry().registerAll(Object.values(falTrainers));

  const registry = createNodeRegistry({ providers });
  const assets = new R2AssetStore(opts.media);
  const projects = new D1ProjectStore(opts.db);
  const library = new D1LibraryStore(opts.db);
  // Persistent cache: unchanged frames stay free across requests/evictions, so
  // an iterative workflow never re-bills a paid model for an image it made.
  // concurrency 2 keeps concurrent fal calls comfortably inside the 6-connection
  // per-invocation limit.
  const executor = new Executor({ registry, cache: new D1OutputCache(opts.db), concurrency: 2 });

  const services: ExecutionServices = {
    assets,
    getApiKey: (provider) =>
      (opts.env as Record<string, string | undefined>)[`${provider.toUpperCase()}_KEY`],
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
    consumesReferences: m.consumesReferences ?? false,
    consumesLoras: m.consumesLoras ?? false,
    maxReferences: m.maxReferences,
    pricing: m.pricing,
  }));
}
