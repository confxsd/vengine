import type { TextAdapter } from "./types.js";

/** Registry of text/LLM adapters. The assist routes resolve their model here.
 *  Mirrors `ProviderRegistry` (image models) so both layers expand the same way. */
export class TextProviderRegistry {
  private readonly adapters = new Map<string, TextAdapter>();

  register(adapter: TextAdapter): this {
    if (this.adapters.has(adapter.id)) {
      throw new Error(`Text adapter already registered: ${adapter.id}`);
    }
    this.adapters.set(adapter.id, adapter);
    return this;
  }

  registerAll(adapters: Iterable<TextAdapter>): this {
    for (const a of adapters) this.register(a);
    return this;
  }

  get(id: string): TextAdapter | undefined {
    return this.adapters.get(id);
  }

  require(id: string): TextAdapter {
    const a = this.adapters.get(id);
    if (!a) throw new Error(`Unknown text model: ${id}`);
    return a;
  }

  list(): TextAdapter[] {
    return [...this.adapters.values()];
  }
}
