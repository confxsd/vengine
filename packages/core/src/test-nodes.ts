import { z } from "zod";
import type { NodeDefinition } from "./node.js";

/** Test fixtures: tiny deterministic nodes used by the engine test suite. */

/** Emits a constant number. */
export const constNode: NodeDefinition<{ value: number }> = {
  type: "test.const",
  category: "logic",
  title: "Const",
  inputs: [],
  outputs: [{ id: "out", type: "number", label: "Out" }],
  paramsSchema: z.object({ value: z.number() }),
  async execute({ params }) {
    return { out: params.value };
  },
};

/**
 * A mock "generation" node: declares a cost, honours preview/final quality, and
 * counts executions. Stands in for a real API generation node in engine tests.
 */
export function makeRenderNode(counter: { count: number; lastQuality?: string }) {
  const node: NodeDefinition<{ price: number }> = {
    type: "test.render",
    category: "generation",
    title: "Render",
    inputs: [{ id: "in", type: "number", label: "In", required: true }],
    outputs: [{ id: "image", type: "number", label: "Image" }],
    paramsSchema: z.object({ price: z.number() }),
    estimateCost({ params, quality }) {
      return quality === "preview" ? params.price * 0.1 : params.price;
    },
    async execute({ inputs, ctx }) {
      counter.count += 1;
      counter.lastQuality = ctx.quality;
      return { image: inputs.in as number };
    },
  };
  return node;
}

/** Adds two numbers. Increments a shared counter so tests can assert execution. */
export function makeAddNode(counter: { count: number }): NodeDefinition<Record<string, never>> {
  return {
    type: "test.add",
    category: "logic",
    title: "Add",
    inputs: [
      { id: "a", type: "number", label: "A", required: true },
      { id: "b", type: "number", label: "B", required: true },
    ],
    outputs: [{ id: "sum", type: "number", label: "Sum" }],
    async execute({ inputs }) {
      counter.count += 1;
      return { sum: (inputs.a as number) + (inputs.b as number) };
    },
  };
}
