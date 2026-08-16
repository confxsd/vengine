import type { NodeProgressEvent } from "@vengine/shared";
import type { Runtime } from "./runtime.js";
import type { RunHost, RunHostRequest, RunResultWithProduced } from "./run-host.js";

/**
 * Local RunHost: executes the graph inline with the singleton executor and
 * registers an AbortController per run so the cancel endpoint can stop any
 * paid generation in flight.
 */
export class NodeRunHost implements RunHost {
  private readonly runs = new Map<string, AbortController>();

  constructor(private readonly rt: Runtime) {}

  async run(runId: string, req: RunHostRequest): Promise<RunResultWithProduced> {
    const ac = new AbortController();
    this.runs.set(runId, ac);
    const produced: Record<string, string> = {};
    const emit = (e: NodeProgressEvent) => {
      if (e.previewHash) produced[e.nodeId] = e.previewHash;
      req.emit(e);
    };
    try {
      const result = await this.rt.executor.run(req.graph, {
        runId,
        services: this.rt.services,
        quality: req.quality,
        targets: req.targets,
        emit,
        signal: ac.signal,
      });
      return { ...result, produced };
    } finally {
      this.runs.delete(runId);
    }
  }

  async cancel(runId: string): Promise<boolean> {
    const ac = this.runs.get(runId);
    if (!ac) return false;
    ac.abort();
    return true;
  }
}
