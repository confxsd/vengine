import { z } from "zod";

/**
 * An asset is a content-addressed binary (image/mask). Its `hash` (sha256 of
 * the bytes) is the primary key everywhere: the generation cache, the gallery,
 * and node outputs all reference assets by hash, giving automatic dedup.
 */
export const AssetSchema = z.object({
  hash: z.string().length(64),
  mime: z.string(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  bytes: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
});
export type Asset = z.infer<typeof AssetSchema>;

/** A reference to an asset as it flows through ports (the engine passes hashes, not bytes). */
export const AssetRefSchema = z.object({
  hash: z.string().length(64),
  mime: z.string(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
});
export type AssetRef = z.infer<typeof AssetRefSchema>;
