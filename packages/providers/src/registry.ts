import type { Capability, ModelAdapter } from "./types.js";

/** Registry of model adapters. The model picker and generation nodes resolve here. */
export class ProviderRegistry {
  private readonly adapters = new Map<string, ModelAdapter>();

  register(adapter: ModelAdapter): this {
    if (this.adapters.has(adapter.id)) {
      throw new Error(`Model adapter already registered: ${adapter.id}`);
    }
    this.adapters.set(adapter.id, adapter);
    return this;
  }

  registerAll(adapters: Iterable<ModelAdapter>): this {
    for (const a of adapters) this.register(a);
    return this;
  }

  get(id: string): ModelAdapter | undefined {
    return this.adapters.get(id);
  }

  require(id: string): ModelAdapter {
    const a = this.adapters.get(id);
    if (!a) throw new Error(`Unknown model: ${id}`);
    return a;
  }

  list(): ModelAdapter[] {
    return [...this.adapters.values()];
  }

  /** Models supporting a given capability — drives capability-aware node UIs. */
  listByCapability(cap: Capability): ModelAdapter[] {
    return this.list().filter((a) => a.capabilities.includes(cap));
  }
}
