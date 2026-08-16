import type { RunResult } from "@vengine/core";
import type { GraphDocument, NodeProgressEvent } from "@vengine/shared";

export interface RunHostRequest {
  graph: GraphDocument;
  quality?: "preview" | "final";
  /** If set, run only the sub-DAG required to produce these node outputs. */
  targets?: string[];
  /** Stream a progress/preview event to listeners (e.g. the WebSocket layer). */
  emit: (event: NodeProgressEvent) => void;
}

/**
 * A RunResult plus the streamed per-node preview hashes: nodes that emitted a
 * preview and then failed/cancelled have no `outputs`, so callers persist what
 * actually finished instead of losing a paid image to an early stop.
 */
export interface RunResultWithProduced extends RunResult {
  /** nodeId → asset hash, from `previewHash` events seen during the run. */
  produced: Record<string, string>;
}

/**
 * Executes engine graphs. The Node server runs them inline (one executor per
 * request); the Cloudflare Worker delegates to a Durable Object that batches
 * execution across alarm invocations (the free plan caps subrequests per
 * invocation). Route modules depend only on this interface.
 */
export interface RunHost {
  run(runId: string, req: RunHostRequest): Promise<RunResultWithProduced>;
  cancel(runId: string): Promise<boolean>;
}
