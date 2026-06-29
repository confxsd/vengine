import { randomUUID } from "node:crypto";
import { FalHttpError, type TrainingAdapter, type TrainingHandle } from "@vengine/providers";
import type { AssetStore, LibraryStore } from "@vengine/storage";
import { TrainingStatus, LoraKind, trainingEvent, type TrainedLora, type TrainingProgressEvent } from "@vengine/shared";

/** How often a background job polls fal for status. */
const DEFAULT_POLL_MS = 5000;
/** Hard ceiling on a single job's lifetime — beyond this we stop polling and fail it
 *  (a stuck/abandoned fal job can't pin a poll loop forever). */
const DEFAULT_DEADLINE_MS = 45 * 60_000;

export interface StartTrainingParams {
  trainerId: string;
  name: string;
  kind: LoraKind;
  /** Asset hashes used as the dataset (e.g. a character's reference-sheet crops). */
  refHashes: string[];
  /** Optional captions, aligned to `refHashes` by index (empty string = none). */
  captions?: string[];
  triggerWord?: string;
  defaultCaption?: string;
  isStyle?: boolean;
  steps?: number;
  /** When set, the resulting LoRA is attached to this library character on success. */
  characterId?: string;
}

export interface TrainingServiceDeps {
  library: LibraryStore;
  assets: AssetStore;
  trainers: { get(id: string): TrainingAdapter | undefined; require(id: string): TrainingAdapter };
  /** Resolve the fal API key (server env only). */
  getApiKey: () => string | undefined;
  /** Push a training-progress event to connected clients (best-effort). */
  broadcast: (event: TrainingProgressEvent) => void;
  /** Override for tests. */
  pollMs?: number;
  deadlineMs?: number;
  now?: () => number;
}

/**
 * Owns the **lifecycle of long training jobs**, independent of any HTTP request.
 *
 * `start` submits to the trainer, persists a `TrainedLora{status:"training"}` record
 * (with fal's durable job handle), and kicks off a background poll loop — then
 * returns. The client tracks progress via the persisted record (source of truth) +
 * best-effort WS events, so a client disconnect or a dropped socket loses nothing.
 * `resume` re-attaches poll loops to in-flight records on server boot, so a restart
 * mid-train doesn't orphan a job (fal keeps running it; we keep watching).
 *
 * Invariants: at most one live poll loop per record id (`active`); every terminal
 * transition patches the record AND broadcasts; a vanished record (user deleted it
 * mid-train) ends the loop quietly.
 */
export class TrainingService {
  private readonly active = new Map<string, ReturnType<typeof setTimeout>>();
  /** Ids cancelled mid-tick (deleted while a poll was in flight) — checked so an
   *  in-flight tick stops instead of rescheduling. Only ever holds ids whose timer
   *  had already fired, so it stays empty in steady state. */
  private readonly cancelled = new Set<string>();
  private readonly pollMs: number;
  private readonly deadlineMs: number;
  private readonly now: () => number;

  constructor(private readonly deps: TrainingServiceDeps) {
    this.pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
    this.deadlineMs = deps.deadlineMs ?? DEFAULT_DEADLINE_MS;
    this.now = deps.now ?? Date.now;
  }

  /**
   * Submit a new training job and begin tracking it. Returns the created record.
   *
   * Ordering matters for real money: we persist an **intent record first**, then
   * submit, then patch in the durable handle. So a crash or a persist failure can
   * never leave a paid fal job with no record at all, and a submit failure marks the
   * record `failed` (visible) instead of throwing away a phantom job.
   */
  async start(params: StartTrainingParams): Promise<TrainedLora> {
    const trainer = this.deps.trainers.require(params.trainerId);
    const apiKey = this.deps.getApiKey();
    if (!apiKey) throw new Error("Missing FAL_KEY — set it in the server env to train.");
    if (params.refHashes.length === 0) throw new Error("No training images selected.");

    // Load dataset bytes from the content-addressed asset store (cross-project).
    const examples = await Promise.all(
      params.refHashes.map(async (hash, i) => {
        const meta = await this.deps.assets.getMeta(hash);
        const bytes = new Uint8Array(await this.deps.assets.get(hash));
        const caption = params.captions?.[i]?.trim();
        return caption ? { bytes, mime: meta.mime, caption } : { bytes, mime: meta.mime };
      }),
    );

    const input = {
      examples,
      steps: params.steps,
      triggerWord: params.triggerWord,
      defaultCaption: params.defaultCaption,
      isStyle: params.isStyle ?? params.kind === LoraKind.Style,
    };

    const id = randomUUID().slice(0, 8);
    // (1) Intent record — persisted BEFORE any paid call, with an empty job handle.
    let record = await this.deps.library.upsertTrainedLora({
      id,
      name: params.name,
      kind: params.kind,
      trainerId: trainer.id,
      baseModelId: trainer.baseModelId,
      trigger: params.triggerWord ?? "",
      loraUrl: "",
      configUrl: "",
      datasetHashes: params.refHashes,
      steps: params.steps ?? 0,
      costUsd: trainer.estimateCost(input),
      status: TrainingStatus.Training,
      error: "",
      jobId: "",
      jobEndpoint: "",
      jobStatusUrl: "",
      jobResponseUrl: "",
    });
    // Attach to the character now (atomic field patch, not a stale full-record write)
    // so the UI shows "training" on it immediately.
    if (params.characterId) await this.deps.library.patchCharacter(params.characterId, { loraId: id });
    this.deps.broadcast(trainingEvent(record, new Date().toISOString()));

    // (2) Submit (paid). A failure marks the intent record failed, not a dangling job.
    let handle: TrainingHandle;
    try {
      handle = await trainer.submit(input, { apiKey });
    } catch (err) {
      await this.fail(id, err instanceof Error ? err.message : String(err));
      throw err;
    }

    // (3) Patch in the durable handle so a restart can resume this exact job.
    record =
      (await this.deps.library.patchTrainedLora(id, {
        steps: handle.steps,
        jobId: handle.jobId,
        jobEndpoint: handle.endpoint,
        jobStatusUrl: handle.statusUrl,
        jobResponseUrl: handle.responseUrl,
      })) ?? record;
    this.deps.broadcast(trainingEvent(record, new Date().toISOString()));

    this.track(record, trainer, apiKey);
    return record;
  }

  /**
   * Re-attach poll loops to every job left `status:"training"` (called on boot).
   * A record with no recoverable job handle (never actually submitted) is failed; one
   * whose trainer is gone is failed. But a **missing API key is treated as transient**
   * — we leave the job `training` and try again on the next boot rather than
   * permanently failing a still-running, already-paid job over a key that may return.
   */
  async resume(): Promise<void> {
    const lib = await this.deps.library.get();
    for (const rec of lib.trainedLoras) {
      if (rec.status !== TrainingStatus.Training || this.active.has(rec.id)) continue;
      const trainer = this.deps.trainers.get(rec.trainerId);
      if (!trainer || !rec.jobId || !rec.jobStatusUrl) {
        await this.fail(rec.id, "could not resume after restart (no recoverable job handle)");
        continue;
      }
      const apiKey = this.deps.getApiKey();
      if (!apiKey) {
        console.warn(`training ${rec.id}: FAL_KEY absent on boot — leaving 'training' to resume later`);
        continue; // non-terminal: do NOT fail a paid job over a transiently-missing key
      }
      this.track(rec, trainer, apiKey);
    }
  }

  /** Stop tracking + remove a record (also cancels any in-flight poll loop). */
  async remove(id: string): Promise<void> {
    const timer = this.active.get(id);
    if (timer) {
      clearTimeout(timer); // a tick is pending, not running → just cancel the timer
      this.active.delete(id);
    } else {
      this.cancelled.add(id); // a tick is in flight → tell it to stop before rescheduling
    }
    await this.deps.library.removeTrainedLora(id);
  }

  /** Reconstruct the durable handle from a persisted record. */
  private handleOf(rec: TrainedLora): TrainingHandle {
    return {
      jobId: rec.jobId,
      endpoint: rec.jobEndpoint,
      steps: rec.steps,
      statusUrl: rec.jobStatusUrl,
      responseUrl: rec.jobResponseUrl,
    };
  }

  /** Begin (or resume) the poll loop for a record. */
  private track(rec: TrainedLora, trainer: TrainingAdapter, apiKey: string): void {
    const handle = this.handleOf(rec);
    // Anchor the deadline to when the job actually *started* (its record's createdAt),
    // not to now — otherwise every restart hands a long-running job a fresh full
    // budget and a stuck job could be polled forever across restarts.
    const started = rec.createdAt ? Date.parse(rec.createdAt) : NaN;
    const deadline = (Number.isNaN(started) ? this.now() : started) + this.deadlineMs;

    const tick = async (): Promise<void> => {
      this.active.delete(rec.id);
      // Deleted while this tick's poll was in flight → stop without rescheduling.
      if (this.cancelled.has(rec.id)) {
        this.cancelled.delete(rec.id);
        return;
      }
      if (this.now() > deadline) {
        await this.fail(rec.id, "training timed out");
        return;
      }

      try {
        const poll = await trainer.poll(handle, { apiKey });
        if (poll.status === TrainingStatus.Ready && poll.result) {
          await this.complete(rec.id, poll.result.loraUrl, poll.result.configUrl ?? "", poll.result.costUsd);
        } else if (poll.status === TrainingStatus.Failed) {
          await this.fail(rec.id, poll.error ?? "training failed");
        } else {
          this.reschedule(rec.id, tick);
        }
      } catch (err) {
        // Fail fast on a TERMINAL fal error (bad key, expired/unknown job) instead of
        // retrying it until the deadline; keep polling only through transient ones
        // (network blips, 5xx, rate-limits).
        if (err instanceof FalHttpError && err.terminal) {
          await this.fail(rec.id, `fal training error ${err.status}: ${err.message}`);
          return;
        }
        console.warn(`training ${rec.id} poll error (will retry):`, err instanceof Error ? err.message : err);
        this.reschedule(rec.id, tick);
      }
    };

    this.schedule(rec.id, tick);
  }

  /** Reschedule a tick unless the job was cancelled mid-flight. */
  private reschedule(id: string, tick: () => Promise<void>): void {
    if (this.cancelled.has(id)) {
      this.cancelled.delete(id);
      return;
    }
    this.schedule(id, tick);
  }

  private schedule(id: string, tick: () => Promise<void>): void {
    const timer = setTimeout(() => void tick(), this.pollMs);
    // Don't keep the process alive solely for a poll timer.
    if (typeof timer.unref === "function") timer.unref();
    this.active.set(id, timer);
  }

  private async complete(id: string, loraUrl: string, configUrl: string, costUsd: number): Promise<void> {
    const rec = await this.deps.library.patchTrainedLora(id, {
      status: TrainingStatus.Ready,
      loraUrl,
      configUrl,
      costUsd,
    });
    if (rec) this.deps.broadcast(trainingEvent(rec, new Date().toISOString()));
  }

  private async fail(id: string, error: string): Promise<void> {
    const rec = await this.deps.library.patchTrainedLora(id, { status: TrainingStatus.Failed, error });
    if (rec) this.deps.broadcast(trainingEvent(rec, new Date().toISOString()));
  }
}
