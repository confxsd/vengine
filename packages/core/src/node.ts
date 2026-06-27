import type { z } from "zod";
import type { PortType, NodeProgressEvent } from "@vengine/shared";

export type NodeCategory =
  | "generation"
  | "compositing"
  | "io"
  | "logic"
  | "intelligence";

/** A typed connection point declared by a node definition. */
export interface PortDef {
  id: string;
  type: PortType;
  label: string;
  /** Required inputs must be connected (or have a param default) before the node runs. */
  required?: boolean;
  /** Accept fan-in from multiple edges; the executor passes an array to the node. */
  multiple?: boolean;
}

/** A runtime value flowing along an edge. Refined by node implementations. */
export type PortValue = unknown;

/** Outputs returned by a node, keyed by output port id. */
export type NodeOutputs = Record<string, PortValue>;

/**
 * Services injected into every node's execute(). Augment this interface from the
 * server (declaration merging) to expose providers, the asset store, secrets, etc.,
 * without core taking a dependency on those packages.
 *
 * @example
 * declare module "@vengine/core" {
 *   interface ExecutionServices { providers: ProviderRegistry; assets: AssetStore }
 * }
 */
export interface ExecutionServices {}

/**
 * Render quality for a run. `preview` asks generation nodes to use their cheap,
 * fast path (lower resolution / fewer steps / a cheaper model variant) so the
 * user can iterate before paying for a `final` render.
 */
export type RenderQuality = "preview" | "final";

export interface ExecutionContext {
  runId: string;
  services: ExecutionServices;
  /** Generation nodes should honour this to trade cost for speed. Default "final". */
  quality: RenderQuality;
  /** Stream a progress/preview event to listeners (e.g. the WebSocket layer). */
  emit(event: NodeProgressEvent): void;
}

export interface NodeExecuteArgs<P = Record<string, unknown>> {
  nodeId: string;
  params: P;
  /** Resolved upstream values, keyed by input port id. Array when port.multiple. */
  inputs: Record<string, PortValue | PortValue[]>;
  ctx: ExecutionContext;
  signal: AbortSignal;
}

export interface NodeDefinition<P = Record<string, unknown>> {
  /** Globally unique, dotted, e.g. "generate.text-to-image". */
  type: string;
  /** Bumped when execute() semantics change, to invalidate caches. Default 1. */
  version?: number;
  category: NodeCategory;
  title: string;
  inputs: PortDef[];
  outputs: PortDef[];
  /**
   * Zod schema for params; drives validation and (later) the inspector UI.
   * The input generic is loosened to `unknown` so schemas using `.default()`
   * (whose parsed *output* is P but whose *input* has optionals) still fit.
   */
  paramsSchema?: z.ZodType<P, z.ZodTypeDef, any>;
  /**
   * Project params down to only the fields that affect output, for cache keying.
   * Defaults to the full params object.
   */
  cacheKeyParams?(params: P): unknown;
  /** Set false for non-deterministic nodes that must always re-run. Default true. */
  cacheable?: boolean;
  /**
   * True if the node's output depends on RenderQuality (e.g. generation nodes
   * whose preview path yields different bytes than final). The executor folds
   * `quality` into the cache key so preview and final results never collide.
   */
  qualitySensitive?: boolean;
  /**
   * Estimated USD cost of executing this node, used by the dry-run planner to
   * total a run's spend before committing. Local/free nodes omit it (treated as 0).
   * `inputs` may be partially known during planning, so estimates should rely on
   * params (model, resolution, steps) where possible.
   */
  estimateCost?(args: {
    params: P;
    inputs: Record<string, PortValue | PortValue[]>;
    quality: RenderQuality;
  }): number;
  execute(args: NodeExecuteArgs<P>): Promise<NodeOutputs>;
}
