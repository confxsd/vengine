import { createHash } from "node:crypto";

/**
 * Deterministic JSON stringify: object keys are sorted recursively so that
 * `{a:1,b:2}` and `{b:2,a:1}` serialize identically. Undefined values are
 * dropped (they never affect a cache key). This is the backbone of stable
 * content-addressed hashing.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(normalize);
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    if (obj[key] === undefined) continue;
    out[key] = normalize(obj[key]);
  }
  return out;
}

/** sha256 of arbitrary bytes, hex-encoded. */
export function sha256(bytes: Buffer | Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Stable content hash of any JSON-serializable value. */
export function hashValue(value: unknown): string {
  return sha256(stableStringify(value));
}
