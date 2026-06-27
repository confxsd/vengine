import sharp from "sharp";
import { z } from "zod";
import type { NodeDefinition } from "@vengine/core";
import type { AssetRef } from "@vengine/shared";
import "./services.js";

export const ResizeParams = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fit: z.enum(["cover", "contain", "fill", "inside", "outside"]).default("inside"),
});
export type ResizeParams = z.infer<typeof ResizeParams>;

/**
 * Local compositing node: resize an image via sharp (libvips). Runs for free and
 * is cached like any other node — re-running with unchanged inputs is instant.
 */
export const resizeNode: NodeDefinition<ResizeParams> = {
  type: "compositing.resize",
  category: "compositing",
  title: "Resize",
  inputs: [{ id: "image", type: "image", label: "Image", required: true }],
  outputs: [{ id: "image", type: "image", label: "Image" }],
  paramsSchema: ResizeParams,
  async execute({ params, inputs, ctx }) {
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
