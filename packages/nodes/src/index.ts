import { NodeRegistry } from "@vengine/core";
import type { ProviderRegistry } from "@vengine/providers";
import { createTextToImageNode } from "./image.js";
import { loadImageNode, exportNode } from "./io.js";
import { resizeNode } from "./compositing.js";

export * from "./services.js";
export { createTextToImageNode, TextToImageParams } from "./image.js";
export { loadImageNode, exportNode, ExportParams } from "./io.js";
export { resizeNode, ResizeParams } from "./compositing.js";

export interface NodeDeps {
  providers: ProviderRegistry;
}

/** Build a NodeRegistry populated with all built-in nodes. */
export function createNodeRegistry(deps: NodeDeps): NodeRegistry {
  return new NodeRegistry().registerAll([
    createTextToImageNode(deps.providers),
    loadImageNode,
    resizeNode,
    exportNode,
  ]);
}
