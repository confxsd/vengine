import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import type { Asset, AssetRef } from "@vengine/shared";

export interface AssetStoreOptions {
  /** Root directory; defaults to ~/.vengine/assets. */
  root?: string;
  /** Thumbnail longest-edge in px. */
  thumbSize?: number;
}

/**
 * Content-addressed asset store. Bytes are keyed by their sha256, so identical
 * content is stored once (automatic dedup) and the hash doubles as the cache key
 * across the whole engine. Layout: <root>/<ab>/<hash> (+ .json sidecar) and
 * <root>/thumbs/<hash>.webp.
 */
export class AssetStore {
  private readonly root: string;
  private readonly thumbSize: number;

  constructor(opts: AssetStoreOptions = {}) {
    this.root = opts.root ?? path.join(homedir(), ".vengine", "assets");
    this.thumbSize = opts.thumbSize ?? 256;
  }

  private dir(hash: string): string {
    return path.join(this.root, hash.slice(0, 2));
  }
  filePath(hash: string): string {
    return path.join(this.dir(hash), hash);
  }
  private metaPath(hash: string): string {
    return path.join(this.dir(hash), `${hash}.json`);
  }
  thumbPath(hash: string): string {
    return path.join(this.root, "thumbs", `${hash}.webp`);
  }

  /** Store bytes; returns a ref. Idempotent — re-storing identical bytes is a no-op write. */
  async put(bytes: Uint8Array, mime: string): Promise<AssetRef> {
    const buf = Buffer.from(bytes);
    const hash = createHash("sha256").update(buf).digest("hex");

    if (await this.has(hash)) {
      const meta = await this.getMeta(hash);
      return { hash, mime: meta.mime, width: meta.width, height: meta.height };
    }

    let width: number | undefined;
    let height: number | undefined;
    if (mime.startsWith("image/")) {
      try {
        const m = await sharp(buf).metadata();
        width = m.width;
        height = m.height;
      } catch {
        // non-decodable (e.g. svg without dims) — leave dimensions undefined
      }
    }

    await fs.mkdir(this.dir(hash), { recursive: true });
    await fs.writeFile(this.filePath(hash), buf);
    const asset: Asset = {
      hash,
      mime,
      width,
      height,
      bytes: buf.byteLength,
      createdAt: new Date().toISOString(),
    };
    await fs.writeFile(this.metaPath(hash), JSON.stringify(asset));
    await this.writeThumb(hash, buf, mime);

    return { hash, mime, width, height };
  }

  private async writeThumb(hash: string, buf: Buffer, mime: string): Promise<void> {
    if (!mime.startsWith("image/")) return;
    try {
      const thumb = await sharp(buf)
        .resize(this.thumbSize, this.thumbSize, { fit: "inside", withoutEnlargement: true })
        .webp({ quality: 78 })
        .toBuffer();
      await fs.mkdir(path.join(this.root, "thumbs"), { recursive: true });
      await fs.writeFile(this.thumbPath(hash), thumb);
    } catch {
      // thumbnails are best-effort
    }
  }

  async has(hash: string): Promise<boolean> {
    try {
      await fs.access(this.filePath(hash));
      return true;
    } catch {
      return false;
    }
  }

  async get(hash: string): Promise<Buffer> {
    return fs.readFile(this.filePath(hash));
  }

  async getMeta(hash: string): Promise<Asset> {
    return JSON.parse(await fs.readFile(this.metaPath(hash), "utf8")) as Asset;
  }
}
