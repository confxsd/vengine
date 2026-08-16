import type { Asset, AssetRef } from "@vengine/shared";
import { imageSize, sha256Hex } from "./image-meta.js";
import type { R2BucketLike } from "./bindings.js";
import type { AssetStoreLike } from "../types.js";

export interface R2AssetStoreOptions {
  /** Thumbnail longest-edge — kept for interface parity; workers serve no thumbs. */
  thumbSize?: number;
}

/**
 * Content-addressed asset store backed by R2. Bytes live at `bytes/<sha256>`,
 * metadata (mime, dimensions, size) at `meta/<sha256>`. Identical bytes are
 * stored once — the hash doubles as the engine-wide cache key, same as the
 * file-backed store.
 *
 * Thumbnails are not generated here: sharp (libvips) cannot run on Workers,
 * and a 10ms-CPU free-plan request has no budget for image transcoding. The
 * worker's /api/thumbs route falls back to serving the full asset.
 */
export class R2AssetStore implements AssetStoreLike {
  private readonly thumbSize: number;

  constructor(
    private readonly bucket: R2BucketLike,
    opts: R2AssetStoreOptions = {},
  ) {
    this.thumbSize = opts.thumbSize ?? 256;
  }

  private byteKey(hash: string): string {
    return `bytes/${hash}`;
  }
  private metaKey(hash: string): string {
    return `meta/${hash}`;
  }
  thumbPath(hash: string): string {
    return ""; // no server-side thumbs on the worker — see class docs
  }

  async put(bytes: Uint8Array, mime: string): Promise<AssetRef> {
    const hash = await sha256Hex(bytes);
    if (await this.has(hash)) {
      const meta = await this.getMeta(hash);
      return { hash, mime: meta.mime, width: meta.width, height: meta.height };
    }

    const size = mime.startsWith("image/") ? imageSize(bytes) : undefined;
    const asset: Asset = {
      hash,
      mime,
      width: size?.width,
      height: size?.height,
      bytes: bytes.byteLength,
      createdAt: new Date().toISOString(),
    };
    await this.bucket.put(this.byteKey(hash), bytes, {
      httpMetadata: { contentType: mime },
    });
    await this.bucket.put(this.metaKey(hash), JSON.stringify(asset), {
      httpMetadata: { contentType: "application/json" },
    });
    return { hash, mime, width: asset.width, height: asset.height };
  }

  async has(hash: string): Promise<boolean> {
    return (await this.bucket.head(this.byteKey(hash))) !== null;
  }

  async get(hash: string): Promise<Uint8Array> {
    const obj = await this.bucket.get(this.byteKey(hash));
    if (!obj) throw new Error(`asset not found: ${hash}`);
    return new Uint8Array(await obj.arrayBuffer());
  }

  async getMeta(hash: string): Promise<Asset> {
    const obj = await this.bucket.get(this.metaKey(hash));
    if (!obj) throw new Error(`asset not found: ${hash}`);
    return JSON.parse(T.decode(await obj.arrayBuffer())) as Asset;
  }
}

const T = new TextDecoder();
