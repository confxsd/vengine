import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { OutputCache, NodeOutputs } from "@vengine/core";

export interface FileOutputCacheOptions {
  /** Root directory; defaults to ~/.vengine/cache. */
  root?: string;
}

/**
 * Persistent, content-addressed output cache. The executor's cache key is a
 * sha256 hex string and node outputs are plain `AssetRef`s (JSON-serializable),
 * so a node's result is stored as `<root>/<key[:2]>/<key>.json`.
 *
 * Why this matters: the in-memory cache is wiped on every server restart, which
 * for paid generation models means **re-billing images that already exist**.
 * Backing the cache with disk makes an unchanged frame free across restarts —
 * the single biggest cost lever for an iterative artwork workflow. The asset
 * bytes themselves already persist in the AssetStore, so a hit returns a valid
 * ref whose image is still on disk.
 */
export class FileOutputCache implements OutputCache {
  private readonly root: string;
  /** Process-lifetime memo so repeated lookups in a run skip the disk entirely. */
  private readonly memo = new Map<string, NodeOutputs>();

  constructor(opts: FileOutputCacheOptions = {}) {
    this.root = opts.root ?? path.join(homedir(), ".vengine", "cache");
  }

  private filePath(key: string): string {
    return path.join(this.root, key.slice(0, 2), `${key}.json`);
  }

  async get(key: string): Promise<NodeOutputs | undefined> {
    const memoed = this.memo.get(key);
    if (memoed) return memoed;
    try {
      const raw = await fs.readFile(this.filePath(key), "utf8");
      const outputs = JSON.parse(raw) as NodeOutputs;
      this.memo.set(key, outputs);
      return outputs;
    } catch {
      return undefined; // miss (ENOENT) or unreadable/corrupt → treat as miss
    }
  }

  async set(key: string, outputs: NodeOutputs): Promise<void> {
    this.memo.set(key, outputs);
    const file = this.filePath(key);
    await fs.mkdir(path.dirname(file), { recursive: true });
    // Atomic write: a unique temp avoids torn files / concurrent-writer clobbers.
    const tmp = `${file}.${randomUUID()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(outputs));
    await fs.rename(tmp, file);
  }
}
