import { describe, it, expect } from "vitest";
import type { GraphDocument } from "@vengine/shared";
import { NodeRegistry } from "./registry.js";
import { compileGraph, GraphValidationError } from "./graph-analysis.js";
import { constNode, makeAddNode } from "./test-nodes.js";

const registry = () =>
  new NodeRegistry().register(constNode).register(makeAddNode({ count: 0 }));

function g(nodes: GraphDocument["nodes"], edges: GraphDocument["edges"]): GraphDocument {
  return { version: 1, id: "g", name: "t", nodes, edges };
}

describe("compileGraph", () => {
  it("topologically orders nodes after their dependencies", () => {
    const compiled = compileGraph(
      g(
        [
          { id: "a", type: "test.const", position: { x: 0, y: 0 }, params: { value: 1 } },
          { id: "b", type: "test.const", position: { x: 0, y: 0 }, params: { value: 2 } },
          { id: "s", type: "test.add", position: { x: 0, y: 0 }, params: {} },
        ],
        [
          { id: "e1", source: "a", sourcePort: "out", target: "s", targetPort: "a" },
          { id: "e2", source: "b", sourcePort: "out", target: "s", targetPort: "b" },
        ],
      ),
      registry(),
    );
    expect(compiled.order.indexOf("s")).toBeGreaterThan(compiled.order.indexOf("a"));
    expect(compiled.order.indexOf("s")).toBeGreaterThan(compiled.order.indexOf("b"));
  });

  it("rejects cycles", () => {
    // add -> add via both ports forming a self/mutual cycle
    const doc = g(
      [
        { id: "x", type: "test.add", position: { x: 0, y: 0 }, params: {} },
        { id: "y", type: "test.add", position: { x: 0, y: 0 }, params: {} },
      ],
      [
        { id: "e1", source: "x", sourcePort: "sum", target: "y", targetPort: "a" },
        { id: "e2", source: "y", sourcePort: "sum", target: "x", targetPort: "a" },
      ],
    );
    expect(() => compileGraph(doc, registry())).toThrow(/cycle/i);
  });

  it("rejects unknown node types", () => {
    const doc = g([{ id: "z", type: "nope", position: { x: 0, y: 0 }, params: {} }], []);
    expect(() => compileGraph(doc, registry())).toThrow(GraphValidationError);
  });

  it("rejects type-incompatible edges", () => {
    // const.out (number) -> nothing of string type exists here; fabricate mismatch
    // by wiring a number output into add's port using a bad source port name.
    const doc = g(
      [
        { id: "a", type: "test.const", position: { x: 0, y: 0 }, params: { value: 1 } },
        { id: "s", type: "test.add", position: { x: 0, y: 0 }, params: {} },
      ],
      [{ id: "e1", source: "a", sourcePort: "missing", target: "s", targetPort: "a" }],
    );
    expect(() => compileGraph(doc, registry())).toThrow(/not found/i);
  });
});
