import type { ProviderCtx } from "../types.js";

/**
 * Shared fal.ai async-queue plumbing: submit → poll status → fetch result.
 * Both the image `ModelAdapter` (fal.ts) and the `TrainingAdapter` (fal-training.ts)
 * speak the same queue protocol, differing only in request body, result shape and
 * how long they wait (an image lands in seconds; a LoRA train runs for minutes).
 * Factoring it here keeps that protocol — and its timeout/cancel handling — in one
 * tested place instead of duplicated per adapter.
 */

export const QUEUE_BASE = "https://queue.fal.run";
const POLL_INTERVAL_MS = 1000;
/** Default run deadline for a fast (image) call. Training overrides this — see `TRAIN_POLL_TIMEOUT_MS`. */
export const POLL_TIMEOUT_MS = 180_000;
/** Long deadline for training jobs, which queue + run for minutes, not seconds. */
export const TRAIN_POLL_TIMEOUT_MS = 30 * 60_000;
/**
 * Per-request ceiling for a single fal HTTP call (submit / status poll / result /
 * image download). fal holds its queue connections open and Node's `fetch` has no
 * default timeout, so without this a half-open or stalled socket hangs that one
 * `await` forever — and the run deadline never fires because it is only checked
 * *between* poll iterations, not during a request. Bounding each request means a
 * stalled connection surfaces as an error (releasing the run) instead of pinning
 * the work in a generating state indefinitely.
 */
const REQUEST_TIMEOUT_MS = 60_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A fal HTTP error that carries the status code, so callers can distinguish a
 * **terminal** failure (4xx — bad key, expired/unknown job, rejected request) from a
 * **transient** one (network/timeout/5xx) and decide whether to retry. A long poll
 * loop must fail fast on terminal errors instead of retrying them until its deadline.
 */
export class FalHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "FalHttpError";
  }
  /** 4xx are unrecoverable — except 408 (timeout) and 429 (rate-limit), which retry. */
  get terminal(): boolean {
    return this.status >= 400 && this.status < 500 && this.status !== 408 && this.status !== 429;
  }
}

interface FalSubmit {
  request_id: string;
  status_url?: string;
  response_url?: string;
}
interface FalStatus {
  status: "IN_QUEUE" | "IN_PROGRESS" | "COMPLETED";
}

/**
 * Issue a fal request with a per-request timeout merged onto the caller's cancel
 * signal: a single stalled request can never hang forever, yet a user "Cancel"
 * (which aborts `ctx.signal`) still propagates and stops the fetch. A timeout
 * surfaces as a clear error; a cancel propagates as-is so the run reports cancelled.
 */
export async function falFetch(
  doFetch: typeof fetch,
  url: string,
  init: RequestInit,
  signal: AbortSignal | undefined,
): Promise<Response> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const merged = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    return await doFetch(url, { ...init, signal: merged });
  } catch (err) {
    if (signal?.aborted) throw err; // user cancel — let it propagate unchanged
    if (timeout.aborted) throw new Error(`fal request timed out after ${REQUEST_TIMEOUT_MS}ms: ${url}`);
    throw err;
  }
}

function authHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Key ${apiKey}`, "Content-Type": "application/json" };
}

/**
 * Naive reconstruction of fal's queue URLs from `(endpoint, requestId)`. fal's
 * status/result URLs are rooted at the *app*, which for a sub-pathed endpoint
 * (e.g. `…/gemini-3-pro-image-preview/edit`) is NOT the full slug — so this is only
 * a **fallback** when the submit response omits the authoritative URLs. Always
 * prefer `FalHandle.statusUrl`/`responseUrl` returned by `falSubmit`.
 */
export function falRequestUrls(endpoint: string, requestId: string): {
  statusUrl: string;
  responseUrl: string;
} {
  const base = `${QUEUE_BASE}/${endpoint}/requests/${requestId}`;
  return { statusUrl: `${base}/status`, responseUrl: base };
}

/** A submitted job: its durable id plus fal's *authoritative* status/result URLs. */
export interface FalHandle {
  requestId: string;
  statusUrl: string;
  responseUrl: string;
}

/**
 * Submit a job to a fal queue endpoint; resolve to a durable handle. Uses the
 * `status_url`/`response_url` fal returns (authoritative — correct even when the
 * endpoint is sub-pathed), falling back to the naive scheme only if absent. The
 * caller persists this handle so a restart can resume polling without re-deriving
 * a possibly-wrong URL.
 */
export async function falSubmit(
  doFetch: typeof fetch,
  endpoint: string,
  body: Record<string, unknown>,
  ctx: ProviderCtx,
): Promise<FalHandle> {
  if (!ctx.apiKey) throw new Error(`Missing fal API key for ${endpoint}. Set FAL_KEY in the server env.`);
  const res = await falFetch(
    doFetch,
    `${QUEUE_BASE}/${endpoint}`,
    { method: "POST", headers: authHeaders(ctx.apiKey), body: JSON.stringify(body) },
    ctx.signal,
  );
  if (!res.ok) throw new FalHttpError(res.status, `fal submit failed (${res.status}): ${await res.text()}`);
  const submit = (await res.json()) as FalSubmit;
  if (!submit.request_id) throw new Error(`fal submit returned no request_id for ${endpoint}`);
  const fallback = falRequestUrls(endpoint, submit.request_id);
  return {
    requestId: submit.request_id,
    statusUrl: submit.status_url ?? fallback.statusUrl,
    responseUrl: submit.response_url ?? fallback.responseUrl,
  };
}

/** One status poll → fal's status string ("IN_QUEUE" | "IN_PROGRESS" | "COMPLETED"). */
export async function falPollStatus(
  doFetch: typeof fetch,
  statusUrl: string,
  ctx: ProviderCtx,
): Promise<string> {
  if (!ctx.apiKey) throw new Error("Missing fal API key.");
  const res = await falFetch(doFetch, statusUrl, { headers: authHeaders(ctx.apiKey) }, ctx.signal);
  if (!res.ok) throw new FalHttpError(res.status, `fal status failed (${res.status}): ${await res.text()}`);
  return ((await res.json()) as FalStatus).status;
}

/** Fetch a completed job's result JSON. Caller knows its own result shape. */
export async function falFetchResult(
  doFetch: typeof fetch,
  responseUrl: string,
  ctx: ProviderCtx,
): Promise<unknown> {
  if (!ctx.apiKey) throw new Error("Missing fal API key.");
  const res = await falFetch(doFetch, responseUrl, { headers: authHeaders(ctx.apiKey) }, ctx.signal);
  if (!res.ok) throw new FalHttpError(res.status, `fal result failed (${res.status}): ${await res.text()}`);
  return res.json();
}

export interface FalQueueOptions {
  /** Run deadline; defaults to `POLL_TIMEOUT_MS`. Training passes `TRAIN_POLL_TIMEOUT_MS`. */
  pollTimeoutMs?: number;
  /** Optional status callback fired once per poll (drives progress UIs). */
  onStatus?: (status: string) => void;
  /** Label used in error messages so a timeout/abort names the failing model. */
  label?: string;
}

/**
 * Submit `body` to a fal queue endpoint and resolve to the parsed result JSON,
 * hiding the submit→poll→result dance. Composed from the durable primitives above;
 * used by image generation (which is request-bound and fine to keep in one call)
 * and by the trainer's convenience `train()`. Throws on HTTP error, run-deadline
 * timeout, or cancellation.
 */
export async function falSubmitAndPoll(
  doFetch: typeof fetch,
  endpoint: string,
  body: Record<string, unknown>,
  ctx: ProviderCtx,
  opts: FalQueueOptions = {},
): Promise<unknown> {
  const { statusUrl, responseUrl } = await falSubmit(doFetch, endpoint, body, ctx);

  const deadline = Date.now() + (opts.pollTimeoutMs ?? POLL_TIMEOUT_MS);
  for (;;) {
    if (ctx.signal?.aborted) throw new Error(`fal run aborted for ${opts.label ?? endpoint}`);
    if (Date.now() > deadline) throw new Error(`fal run timed out for ${opts.label ?? endpoint}`);
    const status = await falPollStatus(doFetch, statusUrl, ctx);
    opts.onStatus?.(status);
    if (status === "COMPLETED") break;
    await sleep(POLL_INTERVAL_MS);
  }
  return falFetchResult(doFetch, responseUrl, ctx);
}
