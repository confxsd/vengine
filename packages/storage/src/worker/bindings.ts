/**
 * Minimal structural typing for Cloudflare bindings, so this package compiles
 * (and unit-tests) without depending on @cloudflare/workers-types. The real
 * D1Database / R2Bucket bindings satisfy these shapes.
 */

export interface D1Result {
  meta: { changes: number };
}

export interface D1Prepared {
  bind(...values: unknown[]): D1Prepared;
  first<T = unknown>(col?: string): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[] }>;
  run(): Promise<D1Result>;
}

export interface D1Like {
  prepare(query: string): D1Prepared;
}

export interface R2HeadResult {
  httpMetadata?: { contentType?: string };
}

export interface R2ObjectBodyLike {
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface R2PutOptions {
  httpMetadata?: { contentType?: string };
}

export interface R2BucketLike {
  head(key: string): Promise<R2HeadResult | null>;
  get(key: string): Promise<R2ObjectBodyLike | null>;
  put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null,
    options?: R2PutOptions,
  ): Promise<unknown>;
}
