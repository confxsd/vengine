import type { RunHost, RunHostRequest, RunResultWithProduced } from "../../server/src/run-host.js";
import type { Env } from "./env.js";
import { FEED_ID, type SerializedRun } from "./feed-do.js";

/** Retries for a transient DO RPC failure (e.g. eviction mid-run). */
const MAX_ATTEMPTS = 3;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Durable Object-backed RunHost. The DO plans, batches and executes the graph
 * across alarm invocations (free-plan subrequest budget per invocation) while
 * this RPC stays open — wall time is unlimited while the client is connected.
 * A dropped RPC never orphans work: the DO keeps running and persists results
 * to D1 (`GET /api/run/:id`), and re-calling with the same runId resumes.
 */
export class DoRunHost implements RunHost {
  constructor(private readonly env: Env) {}

  private stub() {
    return this.env.FEED.get(this.env.FEED.idFromName(FEED_ID));
  }

  async run(runId: string, req: RunHostRequest): Promise<RunResultWithProduced> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        const ser = await this.stub().runGraph(runId, req.graph, req.quality, req.targets);
        return fromSerialized(ser);
      } catch (err) {
        lastErr = err;
        if (!isTransientDoError(err)) throw err;
        await sleep(300 * (attempt + 1));
      }
    }
    // The run may still be executing in the DO — surface its persisted state.
    const row = await this.env.DB.prepare("SELECT json FROM runs WHERE id = ?")
      .bind(runId)
      .first<{ json: string }>();
    if (row) return fromSerialized(JSON.parse(row.json) as SerializedRun);
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  async cancel(runId: string): Promise<boolean> {
    return this.stub().cancelRun(runId);
  }
}

function fromSerialized(ser: SerializedRun): RunResultWithProduced {
  return {
    runId: ser.runId,
    status: ser.status,
    error: ser.error,
    nodes: new Map(ser.nodes),
    produced: ser.produced,
  };
}

/** Eviction / overload errors are retryable; a failed run surfaces as a normal
 *  RunResult (status "error"), not an RPC exception. */
function isTransientDoError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /durable object|subrequest failed|evicted|overloaded|network/i.test(msg);
}
