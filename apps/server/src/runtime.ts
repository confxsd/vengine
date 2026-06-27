import { Executor, type ExecutionServices, type NodeRegistry } from "@vengine/core";
import { ProviderRegistry, mockModel, falModels } from "@vengine/providers";
import { AssetStore, ProjectStore, FileOutputCache } from "@vengine/storage";
import { createNodeRegistry } from "@vengine/nodes";

/**
 * Singleton engine wiring shared by all routes. Providers, node registry, asset
 * store, and executor are constructed once. API keys are resolved from the
 * server environment only — never accepted from or sent to the client.
 */
export interface Runtime {
  providers: ProviderRegistry;
  registry: NodeRegistry;
  assets: AssetStore;
  projects: ProjectStore;
  executor: Executor;
  services: ExecutionServices;
}

export function createRuntime(): Runtime {
  const providers = new ProviderRegistry()
    .register(mockModel)
    .registerAll(Object.values(falModels));

  const registry = createNodeRegistry({ providers });
  const assets = new AssetStore();
  const projects = new ProjectStore();
  // Persistent cache: unchanged frames stay free across server restarts so an
  // iterative workflow never re-bills a paid model for an image it already made.
  const executor = new Executor({ registry, cache: new FileOutputCache(), concurrency: 4 });

  const services: ExecutionServices = {
    assets,
    getApiKey: (provider) => process.env[`${provider.toUpperCase()}_KEY`],
  };

  return { providers, registry, assets, projects, executor, services };
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
    pricing: m.pricing,
  }));
}
