import type { GraphDocument } from "@vengine/shared";
import type { NodeRunStatus, RunStatus } from "@vengine/shared";
import type {
  ExecutionContext,
  ExecutionServices,
  NodeDefinition,
  NodeOutputs,
  PortValue,
  RenderQuality,
} from "./node.js";
import { NodeRegistry } from "./registry.js";
import {
  compileGraph,
  collectRequired,
  type CompiledGraph,
  type CompiledNode,
} from "./graph-analysis.js";
import { type OutputCache, NullCache } from "./cache.js";
import { hashValue } from "./hash.js";

export interface NodeResult {
  nodeId: string;
  status: Extract<NodeRunStatus, "done" | "cached" | "error">;
  outputs?: NodeOutputs;
  error?: string;
}

export interface RunResult {
  runId: string;
  status: RunStatus;
  nodes: Map<string, NodeResult>;
  error?: string;
}

export interface ExecutorOptions {
  registry: NodeRegistry;
  cache?: OutputCache;
  /** Max nodes executing concurrently. */
  concurrency?: number;
}

export interface RunOptions {
  runId: string;
  services: ExecutionServices;
  quality?: RenderQuality;
  /** If set, run only the sub-DAG required to produce these node outputs. */
  targets?: string[];
  emit?: ExecutionContext["emit"];
  signal?: AbortSignal;
}

/** Per-node entry of a dry-run plan. */
export interface PlanNode {
  nodeId: string;
  type: string;
  /** True if this node will execute (cache miss or downstream of one). */
  willRun: boolean;
  /** Estimated USD cost if it runs (0 for cached or free/local nodes). */
  estCost: number;
}

export interface RunPlan {
  nodes: PlanNode[];
  willRunCount: number;
  cachedCount: number;
  /** Total estimated USD spend for the cache-miss generation nodes. */
  estTotalCost: number;
}

/**
 * Executes a graph. Compiles to a DAG, optionally prunes to a target sub-DAG,
 * then runs nodes in dependency order with bounded concurrency. Each node's
 * result is keyed by a content-addressed cache key; a cache hit skips execution.
 * Identical cache-miss nodes within one run are coalesced (executed once).
 */
export class Executor {
  private readonly registry: NodeRegistry;
  private readonly cache: OutputCache;
  private readonly concurrency: number;

  constructor(opts: ExecutorOptions) {
    this.registry = opts.registry;
    this.cache = opts.cache ?? new NullCache();
    this.concurrency = Math.max(1, opts.concurrency ?? 4);
  }

  /**
   * Dry-run: walk the graph and predict which nodes will execute and the total
   * estimated cost, *without* running or billing anything. Cache lookups are
   * real; a node is predicted to run if it is a cache miss or sits downstream of
   * one (its inputs would change). Powers confirm-before-spend in the UI.
   */
  async plan(graph: GraphDocument, opts: PlanOptions = {}): Promise<RunPlan> {
    const compiled = compileGraph(graph, this.registry);
    const required = opts.targets
      ? collectRequired(compiled, opts.targets)
      : new Set(compiled.nodes.keys());
    const quality = opts.quality ?? "final";

    const knownOutputs = new Map<string, NodeOutputs>(); // outputs of predicted-hit nodes
    const willRun = new Set<string>();
    const planNodes: PlanNode[] = [];
    let estTotalCost = 0;

    for (const id of compiled.order) {
      if (!required.has(id)) continue;
      const node = compiled.nodes.get(id)!;
      const params = this.validateParams(node.def, node.instance.params);
      const upstreamWillRun = [...node.dependencies].some((d) => willRun.has(d));
      const cacheable = node.def.cacheable !== false;

      let runs: boolean;
      let inputs: Record<string, PortValue | PortValue[]>;
      if (upstreamWillRun || !cacheable) {
        // Inputs would change (or node is non-deterministic) → it must run.
        runs = true;
        inputs = resolveInputs(node, knownOutputs); // may be partially known
      } else {
        inputs = resolveInputs(node, knownOutputs);
        const cached = await this.cache.get(computeCacheKey(node.def, params, inputs, quality));
        if (cached) {
          runs = false;
          knownOutputs.set(id, cached);
        } else {
          runs = true;
        }
      }

      const estCost = runs
        ? (node.def.estimateCost?.({ params, inputs, quality }) ?? 0)
        : 0;
      if (runs) {
        willRun.add(id);
        estTotalCost += estCost;
      }
      planNodes.push({ nodeId: id, type: node.def.type, willRun: runs, estCost });
    }

    return {
      nodes: planNodes,
      willRunCount: willRun.size,
      cachedCount: planNodes.length - willRun.size,
      estTotalCost,
    };
  }

  async run(graph: GraphDocument, opts: RunOptions): Promise<RunResult> {
    const compiled = compileGraph(graph, this.registry);
    const required = opts.targets
      ? collectRequired(compiled, opts.targets)
      : new Set(compiled.nodes.keys());
    const ctx: ExecutionContext = {
      runId: opts.runId,
      services: opts.services,
      quality: opts.quality ?? "final",
      emit: opts.emit ?? (() => {}),
    };
    const signal = opts.signal ?? new AbortController().signal;

    const outputs = new Map<string, NodeOutputs>();
    const results = new Map<string, NodeResult>();
    /** Coalesce identical cache-miss nodes within this run by cache key. */
    const inflight = new Map<string, Promise<NodeOutputs>>();

    const remaining = new Map<string, number>();
    for (const id of required) {
      const node = compiled.nodes.get(id)!;
      let deps = 0;
      for (const d of node.dependencies) if (required.has(d)) deps += 1;
      remaining.set(id, deps);
    }

    const ready: string[] = [];
    for (const [id, count] of remaining) if (count === 0) ready.push(id);

    return new Promise<RunResult>((resolve) => {
      let active = 0;
      let settled = 0;
      let failed = false;
      const total = required.size;

      const finish = (status: RunStatus, error?: string) =>
        resolve({ runId: opts.runId, status, nodes: results, error });

      const pump = () => {
        if (failed) return;
        if (signal.aborted) {
          failed = true;
          return finish("cancelled", "Run cancelled");
        }
        if (settled === total) return finish("done");

        while (active < this.concurrency && ready.length > 0 && !failed) {
          const id = ready.shift()!;
          const node = compiled.nodes.get(id)!;
          active += 1;
          void this.runNode(node, outputs, inflight, ctx, signal)
            .then((result) => {
              results.set(id, result);
              outputs.set(id, result.outputs ?? {});
              active -= 1;
              settled += 1;
              for (const dependent of node.dependents) {
                if (!required.has(dependent)) continue;
                const next = remaining.get(dependent)! - 1;
                remaining.set(dependent, next);
                if (next === 0) ready.push(dependent);
              }
              pump();
            })
            .catch((err: unknown) => {
              const message = err instanceof Error ? err.message : String(err);
              results.set(id, { nodeId: id, status: "error", error: message });
              ctx.emit({
                runId: opts.runId,
                nodeId: id,
                status: "error",
                error: message,
                at: new Date().toISOString(),
              });
              failed = true;
              finish("error", `Node ${id} failed: ${message}`);
            });
        }
      };

      pump();
    });
  }

  private async runNode(
    node: CompiledNode,
    outputs: Map<string, NodeOutputs>,
    inflight: Map<string, Promise<NodeOutputs>>,
    ctx: ExecutionContext,
    signal: AbortSignal,
  ): Promise<NodeResult> {
    const { def, instance } = node;
    const params = this.validateParams(def, instance.params);
    const inputs = resolveInputs(node, outputs);

    const cacheable = def.cacheable !== false;
    const key = computeCacheKey(def, params, inputs, ctx.quality);

    const emit = (status: NodeRunStatus) =>
      ctx.emit({
        runId: ctx.runId,
        nodeId: instance.id,
        status,
        at: new Date().toISOString(),
      });

    if (cacheable) {
      const cached = await this.cache.get(key);
      if (cached) {
        emit("cached");
        return { nodeId: instance.id, status: "cached", outputs: cached };
      }
      // Coalesce with an identical node already executing in this run.
      const pending = inflight.get(key);
      if (pending) {
        emit("cached");
        return { nodeId: instance.id, status: "cached", outputs: await pending };
      }
    }

    emit("running");
    const exec = def.execute({ nodeId: instance.id, params, inputs, ctx, signal });
    if (cacheable) inflight.set(key, exec);
    let result: NodeOutputs;
    try {
      result = await exec;
    } finally {
      if (cacheable) inflight.delete(key);
    }
    if (cacheable) await this.cache.set(key, result);
    emit("done");
    return { nodeId: instance.id, status: "done", outputs: result };
  }

  private validateParams(def: NodeDefinition<any>, raw: Record<string, unknown>): any {
    if (!def.paramsSchema) return raw;
    const parsed = def.paramsSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`Invalid params for ${def.type}: ${parsed.error.message}`);
    }
    return parsed.data;
  }
}

export interface PlanOptions {
  quality?: RenderQuality;
  targets?: string[];
}

/** Gather resolved upstream values for a node's input ports. */
export function resolveInputs(
  node: CompiledNode,
  outputs: Map<string, NodeOutputs>,
): Record<string, PortValue | PortValue[]> {
  const resolved: Record<string, PortValue | PortValue[]> = {};
  for (const port of node.def.inputs) {
    // Stable order across runs: sort fan-in edges by edge id.
    const edges = node.incoming
      .filter((e) => e.targetPort === port.id)
      .sort((a, b) => a.edgeId.localeCompare(b.edgeId));
    if (edges.length === 0) continue;
    const values = edges.map((e) => outputs.get(e.source)?.[e.sourcePort]);
    resolved[port.id] = port.multiple ? values : values[0];
  }
  return resolved;
}

/**
 * Content-addressed cache key. Identical (type, version, output-affecting params,
 * resolved input values) ⇒ identical key ⇒ cache hit. Because asset values carry
 * their own content hash, this transitively keys on upstream *content*.
 */
export function computeCacheKey(
  def: NodeDefinition<any>,
  params: unknown,
  inputs: Record<string, PortValue | PortValue[]>,
  quality?: RenderQuality,
): string {
  return hashValue({
    type: def.type,
    version: def.version ?? 1,
    params: def.cacheKeyParams ? def.cacheKeyParams(params as any) : params,
    inputs,
    // Only quality-sensitive nodes vary by quality, so others stay cache-stable across modes.
    quality: def.qualitySensitive ? (quality ?? "final") : undefined,
  });
}
