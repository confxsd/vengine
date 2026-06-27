import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { z } from "zod";
import type { NodeDefinition } from "@vengine/core";
import type { AssetRef } from "@vengine/shared";
import "./services.js";

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
    const bytes = await fs.readFile(params.path);
    const ref = await ctx.services.assets.put(new Uint8Array(bytes), mimeFromPath(params.path));
    return { image: ref };
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
