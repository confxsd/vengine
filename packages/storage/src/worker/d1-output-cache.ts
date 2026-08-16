import type { NodeOutputs, OutputCache } from "@vengine/core";
import type { D1Like } from "./bindings.js";

/**
 * Persistent, content-addressed output cache backed by D1. Identical to the
 * file-backed cache in effect — unchanged frames stay free across restarts,
 * the single biggest cost lever for an iterative paid-generation workflow —
 * but durable across worker isolates and evictions.
 */
export class D1OutputCache implements OutputCache {
  /** Per-isolate memo so repeated lookups in a run skip the DB entirely. */
  private readonly memo = new Map<string, NodeOutputs>();

  constructor(private readonly db: D1Like) {}

  async get(key: string): Promise<NodeOutputs | undefined> {
    const memoed = this.memo.get(key);
    if (memoed) return memoed;
    const row = await this.db.prepare("SELECT json FROM cache WHERE key = ?").bind(key).first<{ json: string }>();
    if (!row) return undefined;
    const outputs = JSON.parse(row.json) as NodeOutputs;
    this.memo.set(key, outputs);
    return outputs;
  }

  async set(key: string, outputs: NodeOutputs): Promise<void> {
    this.memo.set(key, outputs);
    await this.db
      .prepare("INSERT OR REPLACE INTO cache (key, json, created_at) VALUES (?, ?, ?)")
      .bind(key, JSON.stringify(outputs), new Date().toISOString())
      .run();
  }
}
