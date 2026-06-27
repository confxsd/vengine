import { describe, it, expect } from "vitest";
import type { GraphDocument } from "@vengine/shared";
import { NodeRegistry } from "./registry.js";
import { Executor } from "./executor.js";
import { MemoryCache } from "./cache.js";
import { constNode, makeRenderNode } from "./test-nodes.js";

/** const(a) -> render(r1) ; const(b) -> render(r2) */
function twoRenderGraph(price = 0.1): GraphDocument {
  return {
    version: 1,
    id: "g",
    name: "t",
    nodes: [
      { id: "a", type: "test.const", position: { x: 0, y: 0 }, params: { value: 1 } },
      { id: "b", type: "test.const", position: { x: 0, y: 0 }, params: { value: 2 } },
      { id: "r1", type: "test.render", position: { x: 0, y: 0 }, params: { price } },
      { id: "r2", type: "test.render", position: { x: 0, y: 0 }, params: { price } },
    ],
    edges: [
      { id: "e1", source: "a", sourcePort: "out", target: "r1", targetPort: "in" },
      { id: "e2", source: "b", sourcePort: "out", target: "r2", targetPort: "in" },
    ],
  };
}

const setup = () => {
  const counter = { count: 0, lastQuality: undefined as string | undefined };
  const registry = new NodeRegistry().register(constNode).register(makeRenderNode(counter));
  return { counter, registry, cache: new MemoryCache() };
};

describe("cost dry-run planner", () => {
  it("totals estimated spend for cache-miss generation nodes", async () => {
    const { registry, cache } = setup();
    const ex = new Executor({ registry, cache });
    const plan = await ex.plan(twoRenderGraph(0.15));

    expect(plan.willRunCount).toBe(4); // 2 const + 2 render, nothing cached yet
    expect(plan.estTotalCost).toBeCloseTo(0.3); // two renders @ 0.15
  });

  it("preview quality estimates the cheaper path", async () => {
    const { registry, cache } = setup();
    const ex = new Executor({ registry, cache });
    const plan = await ex.plan(twoRenderGraph(0.15), { quality: "preview" });
    expect(plan.estTotalCost).toBeCloseTo(0.03); // 2 * 0.15 * 0.1
  });

  it("predicts $0 once results are cached", async () => {
    const { registry, cache } = setup();
    const ex = new Executor({ registry, cache });
    await ex.run(twoRenderGraph(0.15), { runId: "r", services: {} });
    const plan = await ex.plan(twoRenderGraph(0.15));
    expect(plan.willRunCount).toBe(0);
    expect(plan.estTotalCost).toBe(0);
  });
});

describe("execute-to-target", () => {
  it("runs only the sub-DAG feeding the target", async () => {
    const { counter, registry, cache } = setup();
    const ex = new Executor({ registry, cache });
    const result = await ex.run(twoRenderGraph(), {
      runId: "r",
      services: {},
      targets: ["r1"],
    });

    expect(result.nodes.has("r1")).toBe(true);
    expect(result.nodes.has("r2")).toBe(false); // pruned
    expect(counter.count).toBe(1); // only r1 rendered
  });
});

describe("preview quality mode", () => {
  it("passes quality through to generation nodes", async () => {
    const { counter, registry, cache } = setup();
    const ex = new Executor({ registry, cache });
    await ex.run(twoRenderGraph(), { runId: "r", services: {}, quality: "preview" });
    expect(counter.lastQuality).toBe("preview");
  });
});

describe("in-flight coalescing", () => {
  it("executes identical cache-miss nodes once per run", async () => {
    const counter = { count: 0, lastQuality: undefined as string | undefined };
    const registry = new NodeRegistry().register(constNode).register(makeRenderNode(counter));
    const ex = new Executor({ registry, cache: new MemoryCache() });

    // r1 and r2 receive the SAME input (both from const a) and identical params,
    // so they share a cache key and must execute only once.
    const g: GraphDocument = {
      version: 1,
      id: "g",
      name: "t",
      nodes: [
        { id: "a", type: "test.const", position: { x: 0, y: 0 }, params: { value: 7 } },
        { id: "r1", type: "test.render", position: { x: 0, y: 0 }, params: { price: 0.1 } },
        { id: "r2", type: "test.render", position: { x: 0, y: 0 }, params: { price: 0.1 } },
      ],
      edges: [
        { id: "e1", source: "a", sourcePort: "out", target: "r1", targetPort: "in" },
        { id: "e2", source: "a", sourcePort: "out", target: "r2", targetPort: "in" },
      ],
    };

    const result = await ex.run(g, { runId: "r", services: {} });
    expect(result.status).toBe("done");
    expect(result.nodes.get("r1")?.outputs?.image).toBe(7);
    expect(result.nodes.get("r2")?.outputs?.image).toBe(7);
    expect(counter.count).toBe(1); // coalesced
  });
});
