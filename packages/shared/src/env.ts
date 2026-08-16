/**
 * True inside a Cloudflare Worker (workerd). Node-only facilities — local
 * filesystem access, native addons like sharp — are unavailable there, so
 * nodes and adapters branch on this instead of failing at runtime.
 */
export function isWorkerRuntime(): boolean {
  return typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers";
}
