import type { GraphDocument, NodeInstance } from "@vengine/shared";
import { arePortsCompatible } from "@vengine/shared";
import type { NodeDefinition } from "./node.js";
import { NodeRegistry, findPort } from "./registry.js";

export class GraphValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphValidationError";
  }
}

export interface IncomingEdge {
  edgeId: string;
  source: string;
  sourcePort: string;
  targetPort: string;
}

export interface CompiledNode {
  instance: NodeInstance;
  def: NodeDefinition<any>;
  /** Edges feeding this node's input ports. */
  incoming: IncomingEdge[];
  /** Distinct upstream node ids this node depends on. */
  dependencies: Set<string>;
  /** Distinct downstream node ids that depend on this node. */
  dependents: Set<string>;
}

export interface CompiledGraph {
  nodes: Map<string, CompiledNode>;
  /** Topologically sorted node ids: a node always appears after its dependencies. */
  order: string[];
}

/**
 * Validate the graph against the registry and compile it into a DAG with a
 * topological execution order. Throws GraphValidationError on any structural
 * problem (unknown node/port, type mismatch, duplicate id, cycle, over-connected
 * single-input port).
 */
export function compileGraph(graph: GraphDocument, registry: NodeRegistry): CompiledGraph {
  const nodes = new Map<string, CompiledNode>();

  for (const instance of graph.nodes) {
    if (nodes.has(instance.id)) {
      throw new GraphValidationError(`Duplicate node id: ${instance.id}`);
    }
    const def = registry.get(instance.type);
    if (!def) throw new GraphValidationError(`Unknown node type: ${instance.type}`);
    nodes.set(instance.id, {
      instance,
      def,
      incoming: [],
      dependencies: new Set(),
      dependents: new Set(),
    });
  }

  // Track how many edges land on each (node, inputPort) to enforce arity.
  const inboundCount = new Map<string, number>();

  for (const edge of graph.edges) {
    const src = nodes.get(edge.source);
    const dst = nodes.get(edge.target);
    if (!src) throw new GraphValidationError(`Edge ${edge.id} from missing node ${edge.source}`);
    if (!dst) throw new GraphValidationError(`Edge ${edge.id} to missing node ${edge.target}`);

    const outPort = findPort(src.def.outputs, edge.sourcePort);
    if (!outPort) {
      throw new GraphValidationError(
        `Edge ${edge.id}: output port "${edge.sourcePort}" not found on ${src.def.type}`,
      );
    }
    const inPort = findPort(dst.def.inputs, edge.targetPort);
    if (!inPort) {
      throw new GraphValidationError(
        `Edge ${edge.id}: input port "${edge.targetPort}" not found on ${dst.def.type}`,
      );
    }
    if (!arePortsCompatible(outPort.type, inPort.type)) {
      throw new GraphValidationError(
        `Edge ${edge.id}: incompatible types ${outPort.type} → ${inPort.type}`,
      );
    }

    const key = `${edge.target}:${edge.targetPort}`;
    const count = (inboundCount.get(key) ?? 0) + 1;
    inboundCount.set(key, count);
    if (count > 1 && !inPort.multiple) {
      throw new GraphValidationError(
        `Input port "${edge.targetPort}" on ${dst.def.type} accepts a single connection`,
      );
    }

    dst.incoming.push({
      edgeId: edge.id,
      source: edge.source,
      sourcePort: edge.sourcePort,
      targetPort: edge.targetPort,
    });
    dst.dependencies.add(edge.source);
    src.dependents.add(edge.target);
  }

  return { nodes, order: topoSort(nodes) };
}

/**
 * The set of nodes required to produce the given target outputs: the targets
 * plus all their transitive dependencies. Lets the executor run only the relevant
 * sub-DAG (e.g. when previewing a single node) instead of the whole graph.
 */
export function collectRequired(compiled: CompiledGraph, targets: string[]): Set<string> {
  const required = new Set<string>();
  const stack = [...targets];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (required.has(id)) continue;
    const node = compiled.nodes.get(id);
    if (!node) throw new GraphValidationError(`Unknown target node: ${id}`);
    required.add(id);
    for (const dep of node.dependencies) stack.push(dep);
  }
  return required;
}

/** Kahn's algorithm. Throws if a cycle is present. */
function topoSort(nodes: Map<string, CompiledNode>): string[] {
  const remaining = new Map<string, number>();
  for (const [id, node] of nodes) remaining.set(id, node.dependencies.size);

  const ready: string[] = [];
  for (const [id, count] of remaining) if (count === 0) ready.push(id);

  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const dependent of nodes.get(id)!.dependents) {
      const next = remaining.get(dependent)! - 1;
      remaining.set(dependent, next);
      if (next === 0) ready.push(dependent);
    }
  }

  if (order.length !== nodes.size) {
    throw new GraphValidationError("Graph contains a cycle");
  }
  return order;
}
