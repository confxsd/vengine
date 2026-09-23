/**
 * Shared HTTP client for scripts that talk to a vengine API (the deployed worker
 * by default, or a local server). Handles env loading, the admin-password login,
 * cookie-authed JSON calls, and idempotent asset upload from the local store.
 *
 * Env (repo root `.env`): SYNC_REMOTE_URL (default https://vengine.rome.markets),
 * SYNC_REMOTE_PASSWORD (the deployed ADMIN_PASSWORD; not needed for a local server
 * whose gate is off — a 404 on login is treated as "no gate").
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AssetStore } from "@vengine/storage";

// Load the repo-root .env (scripts run via tsx from apps/server/scripts — the
// root is three levels up; the nearer candidates cover other launch dirs).
const here = path.dirname(fileURLToPath(import.meta.url));
for (const dir of [here, path.join(here, ".."), path.join(here, "../.."), path.join(here, "../../..")]) {
  try {
    process.loadEnvFile(path.join(dir, ".env"));
  } catch {
    /* optional */
  }
}

export const REMOTE_URL = (process.env.SYNC_REMOTE_URL ?? "https://vengine.rome.markets").replace(/\/+$/, "");
const PASSWORD = process.env.SYNC_REMOTE_PASSWORD ?? "";

/** Read the base URL per call, so a script can retarget it (e.g. `--local`). */
function baseUrl(): string {
  return (process.env.SYNC_REMOTE_URL ?? REMOTE_URL).replace(/\/+$/, "");
}

let cookie = "";

export async function login(): Promise<void> {
  if (!PASSWORD) {
    console.warn("⚠ SYNC_REMOTE_PASSWORD is not set — continuing unauthenticated (fine for a local server).");
  }
  let res: Response;
  try {
    res = await fetch(`${baseUrl()}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: PASSWORD }),
    });
  } catch (err) {
    throw new Error(`Could not reach ${baseUrl()}: ${err instanceof Error ? err.message : err}`);
  }
  if (res.status === 404) return; // no auth routes → no gate (local server)
  if (!res.ok) throw new Error(`Login failed (${res.status}): ${await res.text()}`);
  cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
}

function authed(init: RequestInit = {}): RequestInit {
  return cookie ? { ...init, headers: { ...init.headers, Cookie: cookie } } : init;
}

async function fail(p: string, res: Response): Promise<never> {
  throw new Error(`${p} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

export async function getJson<T>(p: string): Promise<T> {
  const res = await fetch(`${baseUrl()}${p}`, authed());
  if (!res.ok) return fail(p, res);
  return (await res.json()) as T;
}

export async function putJson<T = unknown>(p: string, body: unknown): Promise<T> {
  const res = await fetch(
    `${baseUrl()}${p}`,
    authed({ method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  );
  if (!res.ok) return fail(p, res);
  return (await res.json()) as T;
}

export async function postJson<T = unknown>(p: string, body: unknown): Promise<T> {
  const res = await fetch(
    `${baseUrl()}${p}`,
    authed({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  );
  if (!res.ok) return fail(p, res);
  return (await res.json()) as T;
}

/** Cheap existence probe: GET the asset, read only the status, cancel the body. */
export async function assetExists(hash: string): Promise<boolean> {
  const res = await fetch(`${baseUrl()}/api/assets/${hash}`, authed());
  await res.body?.cancel().catch(() => undefined);
  return res.ok;
}

/** Upload raw bytes into the remote asset store (content-addressed → idempotent). */
export async function uploadAsset(bytes: Uint8Array, mime: string, name = "reference"): Promise<string> {
  const form = new FormData();
  form.append("file", new File([bytes], name, { type: mime }));
  const res = await fetch(`${baseUrl()}/api/assets`, authed({ method: "POST", body: form }));
  if (!res.ok) return fail("/api/assets", res);
  const ref = (await res.json()) as { hash: string };
  return ref.hash;
}

/**
 * Make sure every hash exists remotely, uploading from the local asset store when
 * missing. Bounded concurrency keeps large migrations polite. Returns the number
 * uploaded.
 */
export async function ensureAssets(hashes: Iterable<string>, local: AssetStore, label = "asset"): Promise<number> {
  const missing: string[] = [];
  for (const hash of new Set(hashes)) {
    if (!(await assetExists(hash))) missing.push(hash);
  }
  if (missing.length === 0) return 0;
  console.log(`  ↻ uploading ${missing.length} missing ${label}(s)…`);
  let done = 0;
  const queue = [...missing];
  await Promise.all(
    Array.from({ length: Math.min(4, queue.length) }, async () => {
      for (;;) {
        const hash = queue.shift();
        if (!hash) return;
        const bytes = new Uint8Array(await local.get(hash));
        const meta = await local.getMeta(hash);
        const ext = meta.mime.split("/")[1]?.split("+")[0] || "png";
        await uploadAsset(bytes, meta.mime, `vengine-${hash.slice(0, 8)}.${ext}`);
        done += 1;
        if (done % 10 === 0) console.log(`    ${done}/${missing.length}`);
      }
    }),
  );
  return missing.length;
}
