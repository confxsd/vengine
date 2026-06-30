import type { VisionAdapter } from "./types.js";

/** Registry of vision/VLM adapters. The scene routes resolve their model here.
 *  Mirrors `TextProviderRegistry` / `ProviderRegistry` so all model layers expand
 *  the same way (register adapters, resolve by id, list for a default). */
export class VisionProviderRegistry {
  private readonly adapters = new Map<string, VisionAdapter>();

  register(adapter: VisionAdapter): this {
    if (this.adapters.has(adapter.id)) {
      throw new Error(`Vision adapter already registered: ${adapter.id}`);
    }
    this.adapters.set(adapter.id, adapter);
    return this;
  }

  registerAll(adapters: Iterable<VisionAdapter>): this {
    for (const a of adapters) this.register(a);
    return this;
  }

  get(id: string): VisionAdapter | undefined {
    return this.adapters.get(id);
  }

  require(id: string): VisionAdapter {
    const a = this.adapters.get(id);
    if (!a) throw new Error(`Unknown vision model: ${id}`);
    return a;
  }

  list(): VisionAdapter[] {
    return [...this.adapters.values()];
  }
}
