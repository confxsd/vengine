/**
 * Admin-password gate for the deployed studio. The app stays fully browsable
 * without a session — reads (GET) are public — but paid/mutating requests
 * (POST/PUT/PATCH/DELETE) require a session cookie minted from the Worker
 * secret `ADMIN_PASSWORD`, so nobody else can spend fal credits or overwrite
 * the owner's work.
 *
 * Local dev stays open when no password secret is configured; production
 * requires one via `secrets.required` in wrangler.jsonc.
 */

/** Paths reachable without a session (login/logout/check only). */
const PUBLIC_PATHS = new Set(["/api/auth/login", "/api/auth/logout", "/api/auth/check"]);

const SESSION_TTL_MS = 30 * 24 * 60 * 60_000; // 30 days
const SESSION_COOKIE = "vengine_auth";

/** Per-isolate failed-login limiter (brute-force guardrail). */
const MAX_ATTEMPTS = 10;
const LOCKOUT_MS = 60_000;
const ATTEMPT_DELAY_MS = 400;
const attempts = new Map<string, { count: number; lockedUntil: number }>();

export function isPublicPath(path: string): boolean {
  return PUBLIC_PATHS.has(path);
}

async function hmacHex(key: string, data: string): Promise<string> {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", k, enc.encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time hex compare (signed cookie = attacker-controlled input). */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

export function sessionCookieValue(password: string, ttlMs = SESSION_TTL_MS): Promise<string> {
  const expiry = Date.now() + ttlMs;
  return hmacHex(password, `vengine:${expiry}`).then((mac) => `${expiry}.${mac}`);
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

export function sessionCookieHeader(value: string): string {
  return `${SESSION_COOKIE}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
}

/** Validate the session cookie against the configured password. */
export async function isAuthed(request: Request, password: string): Promise<boolean> {
  const cookie = parseCookies(request.headers.get("Cookie"))[SESSION_COOKIE];
  if (!cookie) return false;
  const dot = cookie.indexOf(".");
  if (dot <= 0) return false;
  const expiry = Number(cookie.slice(0, dot));
  if (!Number.isFinite(expiry) || expiry < Date.now()) return false;
  const expect = await hmacHex(password, `vengine:${expiry}`);
  return safeEqual(cookie.slice(dot + 1), expect);
}

/** Check + record a login attempt. Returns the failure message, or undefined on success. */
export function recordAttempt(ip: string, ok: boolean): string | undefined {
  if (ok) {
    attempts.delete(ip);
    return undefined;
  }
  const now = Date.now();
  const entry = attempts.get(ip);
  if (entry && now < entry.lockedUntil) return "too many attempts — try again in a minute";
  const next = { count: (entry?.count ?? 0) + 1, lockedUntil: entry?.lockedUntil ?? 0 };
  if (next.count >= MAX_ATTEMPTS) next.lockedUntil = now + LOCKOUT_MS;
  attempts.set(ip, next);
  return undefined;
}

export function attemptDelay(): Promise<void> {
  return new Promise((r) => setTimeout(r, ATTEMPT_DELAY_MS));
}
