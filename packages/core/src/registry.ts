import type { NodeDefinition, PortDef } from "./node.js";

/**
 * The node registry. Adding a node to the engine is a single `register()` call —
 * no core changes. The executor resolves a node instance's `type` to its
 * definition here.
 */
export class NodeRegistry {
  private readonly defs = new Map<string, NodeDefinition<any>>();

  register<P>(def: NodeDefinition<P>): this {
    if (this.defs.has(def.type)) {
      throw new Error(`Node type already registered: ${def.type}`);
    }
    this.defs.set(def.type, def as NodeDefinition<any>);
    return this;
  }

  registerAll(defs: Iterable<NodeDefinition<any>>): this {
    for (const def of defs) this.register(def);
    return this;
  }

  get(type: string): NodeDefinition<any> | undefined {
    return this.defs.get(type);
  }

  /** Throws a clear error if the type is unknown — used by the executor. */
  require(type: string): NodeDefinition<any> {
    const def = this.defs.get(type);
    if (!def) throw new Error(`Unknown node type: ${type}`);
    return def;
  }

  has(type: string): boolean {
    return this.defs.has(type);
  }

  list(): NodeDefinition<any>[] {
    return [...this.defs.values()];
  }
}

/** Find a port definition by id on either side of a node. */
export function findPort(ports: PortDef[], id: string): PortDef | undefined {
  return ports.find((p) => p.id === id);
}
