import type { FeedDo } from "./feed-do.js";

/** Worker bindings — from wrangler.jsonc. */
export interface Env {
  /** D1 database: projects, library, output cache, run results. */
  DB: D1Database;
  /** R2 bucket: content-addressed asset bytes + metadata. */
  MEDIA: R2Bucket;
  /** Durable Object: WS fan-out + batched graph runs + training poll loop. */
  FEED: DurableObjectNamespace<FeedDo>;
  /** Static assets binding (auto-provided by the `assets` config). */
  STATIC: Fetcher;
  /** Secrets — set via `wrangler secret put`. */
  FAL_KEY?: string;
  DEEPSEEK_KEY?: string;
  /** Optional VLM slug override for scene understanding. */
  FAL_VISION_MODEL?: string;
}
