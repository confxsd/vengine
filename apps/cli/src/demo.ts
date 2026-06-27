/**
 * End-to-end demo: build the engine, plan (dry-run cost), run a
 * generate → resize → export graph, then re-plan to show caching at work.
 * Uses the offline mock model, so it runs with no API key.
 *
 *   pnpm --filter @vengine/cli demo
 */
import path from "node:path";
import { Executor, MemoryCache, type ExecutionServices } from "@vengine/core";
import { ProviderRegistry, mockModel, falModels } from "@vengine/providers";
import { AssetStore } from "@vengine/storage";
import { createNodeRegistry } from "@vengine/nodes";
import type { GraphDocument } from "@vengine/shared";

const providers = new ProviderRegistry()
  .register(mockModel)
  .registerAll(Object.values(falModels));

const registry = createNodeRegistry({ providers });
const assets = new AssetStore();
const executor = new Executor({ registry, cache: new MemoryCache(), concurrency: 4 });

const outDir = path.join(process.cwd(), "out");

const graph: GraphDocument = {
  version: 1,
  id: "demo",
  name: "Demo",
  nodes: [
    {
      id: "gen",
      type: "generate.text-to-image",
      position: { x: 0, y: 0 },
      params: {
        model: "mock/gradient",
        prompt: "a serene mountain lake at dawn, minimal",
        width: 768,
        height: 768,
        seed: 42,
      },
    },
    {
      id: "resize",
      type: "compositing.resize",
      position: { x: 0, y: 0 },
      params: { width: 512, height: 512, fit: "cover" },
    },
    {
      id: "export",
      type: "io.export",
      position: { x: 0, y: 0 },
      params: { dir: outDir, filename: "demo", format: "png" },
    },
  ],
  edges: [
    { id: "e1", source: "gen", sourcePort: "image", target: "resize", targetPort: "image" },
    { id: "e2", source: "resize", sourcePort: "image", target: "export", targetPort: "image" },
  ],
};

const services: ExecutionServices = {
  assets,
  getApiKey: (provider) => process.env[`${provider.toUpperCase()}_KEY`],
};

const usd = (n: number) => `$${n.toFixed(4)}`;

async function main(): Promise<void> {
  console.log("● Dry-run plan (no execution, no billing):");
  const plan = await executor.plan(graph);
  console.log(`  ${plan.willRunCount} will run, ${plan.cachedCount} cached → est ${usd(plan.estTotalCost)}\n`);

  console.log("● Running:");
  const result = await executor.run(graph, {
    runId: "run-1",
    services,
    emit: (e) =>
      console.log(
        `  [${e.status.padEnd(7)}] ${e.nodeId}` +
          (e.cost ? `  ${usd(e.cost)}` : "") +
          (e.previewHash ? `  preview:${e.previewHash.slice(0, 12)}` : ""),
      ),
  });
  console.log(`  status: ${result.status}`);
  console.log(`  output: ${result.nodes.get("export")?.outputs?.path}\n`);

  console.log("● Re-plan after run (cache should make generation free):");
  const plan2 = await executor.plan(graph);
  console.log(`  ${plan2.willRunCount} will run, ${plan2.cachedCount} cached → est ${usd(plan2.estTotalCost)}`);
  console.log("  (export always re-runs: it's a side-effecting sink)\n");

  console.log("● Preview-quality plan (cheap path):");
  const previewPlan = await executor.plan(graph, { quality: "preview" });
  console.log(`  est ${usd(previewPlan.estTotalCost)} vs final ${usd(plan.estTotalCost)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
