import { describe, it, expect } from "vitest";
import type { GraphDocument } from "@vengine/shared";
import { NodeRegistry } from "./registry.js";
import { Executor } from "./executor.js";
import { MemoryCache } from "./cache.js";
import { constNode, makeAddNode } from "./test-nodes.js";

function graph(nodes: GraphDocument["nodes"], edges: GraphDocument["edges"]): GraphDocument {
  return { version: 1, id: "g1", name: "test", nodes, edges };
}

/** (2) + (3) -> add -> 5 */
function addGraph(a: number, b: number): GraphDocument {
  return graph(
    [
      { id: "a", type: "test.const", position: { x: 0, y: 0 }, params: { value: a } },
      { id: "b", type: "test.const", position: { x: 0, y: 0 }, params: { value: b } },
      { id: "sum", type: "test.add", position: { x: 0, y: 0 }, params: {} },
    ],
    [
      { id: "e1", source: "a", sourcePort: "out", target: "sum", targetPort: "a" },
      { id: "e2", source: "b", sourcePort: "out", target: "sum", targetPort: "b" },
    ],
  );
}

const run = (ex: Executor, g: GraphDocument) =>
  ex.run(g, { runId: "r1", services: {} });

describe("Executor", () => {
  it("executes in dependency order and produces correct outputs", async () => {
    const counter = { count: 0 };
    const registry = new NodeRegistry().register(constNode).register(makeAddNode(counter));
    const ex = new Executor({ registry });

    const result = await run(ex, addGraph(2, 3));

    expect(result.status).toBe("done");
    expect(result.nodes.get("sum")?.outputs?.sum).toBe(5);
    expect(counter.count).toBe(1);
  });

  it("caches results: identical inputs skip re-execution", async () => {
    const counter = { count: 0 };
    const registry = new NodeRegistry().register(constNode).register(makeAddNode(counter));
    const cache = new MemoryCache();
    const ex = new Executor({ registry, cache });

    const first = await run(ex, addGraph(2, 3));
    expect(first.nodes.get("sum")?.status).toBe("done");

    const second = await run(ex, addGraph(2, 3));
    expect(second.nodes.get("sum")?.status).toBe("cached");
    expect(second.nodes.get("sum")?.outputs?.sum).toBe(5);
    // The add node executed only once across both runs.
    expect(counter.count).toBe(1);
  });

  it("partial re-run: changing one input invalidates only the dependent", async () => {
    const counter = { count: 0 };
    const registry = new NodeRegistry().register(constNode).register(makeAddNode(counter));
    const cache = new MemoryCache();
    const ex = new Executor({ registry, cache });

    await run(ex, addGraph(2, 3)); // count -> 1
    const changed = await run(ex, addGraph(2, 4)); // b changed -> add re-runs

    expect(changed.nodes.get("sum")?.outputs?.sum).toBe(6);
    expect(counter.count).toBe(2);
  });

  it("surfaces node execution errors as a failed run", async () => {
    const registry = new NodeRegistry().register({
      type: "test.boom",
      category: "logic",
      title: "Boom",
      inputs: [],
      outputs: [{ id: "out", type: "number", label: "Out" }],
      async execute() {
        throw new Error("kaboom");
      },
    });
    const ex = new Executor({ registry });
    const result = await run(
      ex,
      graph([{ id: "x", type: "test.boom", position: { x: 0, y: 0 }, params: {} }], []),
    );

    expect(result.status).toBe("error");
    expect(result.nodes.get("x")?.status).toBe("error");
    expect(result.error).toContain("kaboom");
  });
});
