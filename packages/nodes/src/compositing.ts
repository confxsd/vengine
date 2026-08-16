import { z } from "zod";
import { isWorkerRuntime } from "@vengine/shared";
import type { NodeDefinition } from "@vengine/core";
import type { AssetRef } from "@vengine/shared";
import "./services.js";

/** sharp is native (libvips) — resolved at runtime, kept out of worker bundles. */
async function loadSharp(): Promise<typeof import("sharp")> {
  const specifier = "sharp";
  const mod = (await import(specifier)) as { default?: typeof import("sharp") };
  return mod.default ?? (mod as unknown as typeof import("sharp"));
}

export const ResizeParams = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fit: z.enum(["cover", "contain", "fill", "inside", "outside"]).default("inside"),
});
export type ResizeParams = z.infer<typeof ResizeParams>;

/**
 * Local compositing node: resize an image via sharp (libvips). Runs for free and
 * is cached like any other node — re-running with unchanged inputs is instant.
 * Unavailable on Cloudflare Workers (no native addons there).
 */
export const resizeNode: NodeDefinition<ResizeParams> = {
  type: "compositing.resize",
  category: "compositing",
  title: "Resize",
  inputs: [{ id: "image", type: "image", label: "Image", required: true }],
  outputs: [{ id: "image", type: "image", label: "Image" }],
  paramsSchema: ResizeParams,
  async execute({ params, inputs, ctx }) {
    if (isWorkerRuntime()) {
      throw new Error("compositing.resize requires the local Node server (sharp/libvips).");
    }
    const sharp = await loadSharp();
    const ref = inputs.image as AssetRef;
    const buf = await ctx.services.assets.get(ref.hash);
    const out = await sharp(buf)
      .resize(params.width, params.height, { fit: params.fit })
      .png()
      .toBuffer();
    const outRef = await ctx.services.assets.put(new Uint8Array(out), "image/png");
    return { image: outRef };
  },
};
