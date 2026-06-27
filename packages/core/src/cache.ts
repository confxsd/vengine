import type { NodeOutputs } from "./node.js";

/**
 * Output cache keyed by a content-addressed cache key (see computeCacheKey).
 * A hit lets the executor skip a node entirely — the core cost-control
 * mechanism, since generation nodes bill real money on every miss.
 */
export interface OutputCache {
  get(key: string): Promise<NodeOutputs | undefined>;
  set(key: string, outputs: NodeOutputs): Promise<void>;
}

/** Simple in-memory cache. Swapped for a SQLite/asset-backed cache in the server. */
export class MemoryCache implements OutputCache {
  private readonly store = new Map<string, NodeOutputs>();

  async get(key: string): Promise<NodeOutputs | undefined> {
    return this.store.get(key);
  }

  async set(key: string, outputs: NodeOutputs): Promise<void> {
    this.store.set(key, outputs);
  }

  get size(): number {
    return this.store.size;
  }
}

/** A no-op cache (every node always executes). Useful for tests and forced reruns. */
export class NullCache implements OutputCache {
  async get(): Promise<undefined> {
    return undefined;
  }
  async set(): Promise<void> {}
}
