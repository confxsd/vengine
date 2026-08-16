import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { isWorkerRuntime } from "@vengine/shared";
import type { NodeDefinition } from "@vengine/core";
import type { AssetRef } from "@vengine/shared";
import "./services.js";

/**
 * sharp is a native (libvips) addon and cannot run on Cloudflare Workers. The
 * non-literal specifier keeps it out of worker bundles entirely; on the local
 * Node server it resolves from node_modules at runtime.
 */
async function loadSharp(): Promise<typeof import("sharp")> {
  const specifier = "sharp";
  const mod = (await import(specifier)) as { default?: typeof import("sharp") };
  return mod.default ?? (mod as unknown as typeof import("sharp"));
}

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
};

function mimeFromPath(p: string): string {
  return MIME_BY_EXT[path.extname(p).toLowerCase()] ?? "application/octet-stream";
}

/** Load an image file from disk into the asset store. */
export const loadImageNode: NodeDefinition<{ path: string }> = {
  type: "io.load-image",
  category: "io",
  title: "Load Image",
  inputs: [],
  outputs: [{ id: "image", type: "image", label: "Image" }],
  paramsSchema: z.object({ path: z.string().min(1) }),
  async execute({ params, ctx }) {
    if (isWorkerRuntime()) {
      throw new Error("io.load-image needs a local filesystem — upload via POST /api/assets instead.");
    }
    const bytes = await fs.readFile(params.path);
    const ref = await ctx.services.assets.put(new Uint8Array(bytes), mimeFromPath(params.path));
    return { image: ref };
  },
};

/**
 * Source node: emits an already-stored asset (identified by its content hash) as an
 * image value without re-reading bytes. The Focus studio's tree roots on this — the
 * uploaded/chosen image flows into every root-level edit — and because the output
 * carries the content hash, changing the source transitively invalidates downstream
 * cache keys. Verifies the asset exists so a stale source fails loudly, not deep in
 * a paid edit.
 */
export const sourceNode: NodeDefinition<{ hash: string }> = {
  type: "io.source",
  category: "io",
  title: "Source Image",
  inputs: [],
  outputs: [{ id: "image", type: "image", label: "Image" }],
  paramsSchema: z.object({ hash: z.string().length(64) }),
  async execute({ params, ctx }) {
    const meta = await ctx.services.assets.getMeta(params.hash);
    return {
      image: {
        hash: params.hash,
        mime: meta.mime,
        width: meta.width,
        height: meta.height,
      } satisfies AssetRef,
    };
  },
};

export const ExportParams = z.object({
  dir: z.string().min(1),
  filename: z.string().default("output"),
  format: z.enum(["png", "jpeg", "webp"]).default("png"),
});
export type ExportParams = z.infer<typeof ExportParams>;

/**
 * Export sink: writes an image asset to a user directory in the chosen format.
 * Not cacheable — it has a filesystem side effect outside the asset store.
 * On Workers there is no filesystem: the node passes the image through and
 * surfaces its hash, so comic runs (which target export nodes) still stream
 * frame previews and return results.
 */
export const exportNode: NodeDefinition<ExportParams> = {
  type: "io.export",
  category: "io",
  title: "Export",
  cacheable: false,
  inputs: [{ id: "image", type: "image", label: "Image", required: true }],
  outputs: [
    { id: "path", type: "string", label: "Path" },
    { id: "image", type: "image", label: "Image" },
  ],
  paramsSchema: ExportParams,
  async execute({ nodeId, params, inputs, ctx }) {
    const ref = inputs.image as AssetRef;

    if (isWorkerRuntime()) {
      ctx.emit({
        runId: ctx.runId,
        nodeId,
        status: "running",
        previewHash: ref.hash,
        at: new Date().toISOString(),
      });
      return { path: "", image: ref };
    }

    const sharp = await loadSharp();
    const buf = await ctx.services.assets.get(ref.hash);
    const out = await sharp(buf).toFormat(params.format).toBuffer();

    // Resolve ~ and relative dirs to an absolute, user-findable path.
    const expanded = params.dir.startsWith("~")
      ? path.join(homedir(), params.dir.slice(1))
      : params.dir;
    const dir = path.resolve(expanded);
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `${params.filename}.${params.format}`);
    await fs.writeFile(filePath, out);

    // Surface the exported image + path in the node UI (export outputs a path,
    // so without this the node would render blank).
    ctx.emit({
      runId: ctx.runId,
      nodeId,
      status: "running",
      previewHash: ref.hash,
      at: new Date().toISOString(),
    });
    return { path: filePath, image: ref };
  },
};
