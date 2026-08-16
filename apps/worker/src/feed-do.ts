import { DurableObject } from "cloudflare:workers";
import { Executor, NullCache, type NodeResult } from "@vengine/core";
import { FalHttpError, type TrainingHandle } from "@vengine/providers";
import {
  TrainingStatus,
  LoraKind,
  trainingEvent,
  type GraphDocument,
  type NodeProgressEvent,
  type RunStatus,
  type TrainedLora,
  type TrainingProgressEvent,
} from "@vengine/shared";
import { createRuntime } from "./runtime.js";
import type { Runtime } from "./runtime.js";
import type { Env } from "./env.js";
import type { StartTrainingParams } from "../../server/src/training.js";

/** One FeedDo per worker — a named singleton for WS fan-out, batched runs, and training polls. */
export const FEED_ID = "feed";

/** Cadence for continuation alarm wakes while runs are active. */
const RUN_TICK_MS = 400;
/** Cadence for training poll wakes. */
const TRAIN_TICK_MS = 3000;
/** Minimum gap between fal status polls for one training job. */
const TRAIN_POLL_MS = 5000;
/** Hard ceiling on a training job's lifetime (mirrors the Node TrainingService). */
const TRAIN_DEADLINE_MS = 45 * 60_000;
/** Max graph nodes executed per alarm/RPC invocation — keeps the invocation's
 *  subrequests (each node costs ~7-10 fal calls) inside the free-plan budget. */
const BATCH_SIZE = 3;
/** How long finished run rows stay in D1 before pruning. */
const RUN_RETENTION_MS = 7 * 24 * 60 * 60_000;

/** Plain-object form of a RunResult (D1 + RPC serialization). */
export interface SerializedRun {
  runId: string;
  status: RunStatus;
  error?: string;
  nodes: [string, NodeResult][];
  produced: Record<string, string>;
}

/** Persisted run state — everything needed to resume after DO eviction. */
interface PersistedRun extends SerializedRun {
  graph: GraphDocument;
  quality?: "preview" | "final";
  targets?: string[];
  /** Remaining nodes to run, in dependency order (from the initial plan). */
  pending: string[];
  createdAt: string;
}

interface RunState extends PersistedRun {
  ac: AbortController;
  waiters: ((result: SerializedRun) => void)[];
}

/**
 * Single-threaded coordinator for everything long-lived:
 *
 *  - **WS fan-out**: the worker's /ws route forwards the upgrade here; every
 *    connected client receives progress events (run previews, training state).
 *  - **Graph runs**: `runGraph` plans, executes the first batch inline, then
 *    continues in alarm invocations — each wake gets a fresh free-plan
 *    subrequest budget, so a full comic run (hundreds of fal calls) completes
 *    even though one invocation may only make ~50. State is persisted to D1
 *    after every batch, so eviction loses nothing but waiters.
 *  - **Training**: `trainingStart` submits to fal (zip build is CPU-heavy, so
 *    it lives here with the DO's 30s CPU budget); the alarm loop polls due
 *    jobs and patches the library row + broadcasts on completion.
 */
export class FeedDo extends DurableObject<Env> {
  private readonly sessions = new Set<WebSocket>();
  private readonly runs = new Map<string, RunState>();
  private rt: Runtime | undefined;

  /** Engine wiring built against this DO's bindings (rebuilt after eviction). */
  private runtime(): Runtime {
    if (!this.rt) {
      this.rt = createRuntime({ db: this.env.DB, media: this.env.MEDIA, env: this.env });
    }
    return this.rt;
  }

  /** Planner with a null cache — topo order only, no D1 reads (cheap). */
  private planner(): Executor {
    return new Executor({ registry: this.runtime().registry, cache: new NullCache(), concurrency: 1 });
  }

  // ── WebSocket fan-out ───────────────────────────────────────────────────

  override async fetch(request: Request): Promise<Response> {
    const upgrade = request.headers.get("Upgrade");
    if (upgrade?.toLowerCase() === "websocket") {
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      this.sessions.add(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return new Response("vengine feed", { status: 200 });
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    this.sessions.delete(ws);
  }

  override async webSocketMessage(): Promise<void> {
    /* clients only receive — inbound frames are ignored */
  }

  /** RPC entry from the worker: push an event to every connected client. */
  async broadcast(event: NodeProgressEvent | TrainingProgressEvent): Promise<void> {
    this.broadcastLocal(event);
  }

  private broadcastLocal(event: unknown): void {
    const msg = JSON.stringify(event);
    for (const ws of this.sessions) {
      try {
        ws.send(msg);
      } catch {
        this.sessions.delete(ws);
      }
    }
  }

  // ── Graph runs ──────────────────────────────────────────────────────────

  /**
   * Run a graph to completion (or cancellation). Idempotent per runId: a
   * re-call after a transient RPC failure attaches to the same run. The first
   * batch executes inside this call so small runs complete with one round
   * trip; the alarm continues the rest.
   */
  async runGraph(
    runId: string,
    graph: GraphDocument,
    quality?: "preview" | "final",
    targets?: string[],
  ): Promise<SerializedRun> {
    let state = this.runs.get(runId) ?? (await this.loadRun(runId));

    if (!state) {
      const plan = await this.planner().plan(graph, { quality, targets });
      state = {
        runId,
        graph,
        quality,
        targets,
        pending: plan.nodes.filter((n) => n.willRun).map((n) => n.nodeId),
        produced: {},
        nodes: [],
        status: "running",
        ac: new AbortController(),
        waiters: [],
        createdAt: new Date().toISOString(),
      };
      this.runs.set(runId, state);
      await this.persistRun(state);
    }

    if (state.status === "running") {
      try {
        await this.processBatch(state);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await this.finishRun(state, "error", message);
        throw err;
      }
    }

    if (state.status !== "running") return serializeRun(state);

    // Still running — keep the RPC open and let alarms drive the remaining
    // batches (wall time is unlimited while the caller stays connected).
    this.scheduleAlarm();
    return new Promise<SerializedRun>((resolve) => state.waiters.push(resolve));
  }

  async cancelRun(runId: string): Promise<boolean> {
    const state = this.runs.get(runId) ?? (await this.loadRun(runId));
    if (!state || state.status !== "running") return false;
    state.ac.abort();
    await this.finishRun(state, "cancelled", "Run cancelled");
    return true;
  }

  /** Execute the next batch of pending nodes, merging results + persisting. */
  private async processBatch(state: RunState): Promise<void> {
    if (state.status !== "running") return;
    if (state.ac.signal.aborted) {
      await this.finishRun(state, "cancelled", "Run cancelled");
      return;
    }
    const done = new Set(state.nodes.map(([id]) => id));
    const batch = state.pending.filter((id) => !done.has(id)).slice(0, BATCH_SIZE);
    if (batch.length === 0) {
      await this.finishRun(state, "done");
      return;
    }

    const rt = this.runtime();
    const result = await rt.executor.run(state.graph, {
      runId: state.runId,
      services: rt.services,
      quality: state.quality,
      targets: batch,
      emit: (e: NodeProgressEvent) => this.handleEmit(state, e),
      signal: state.ac.signal,
    });

    const byId = new Map(state.nodes);
    for (const [id, nodeResult] of result.nodes) {
      // A later batch re-plans upstream deps as cache hits ("cached") — never
      // let that overwrite a node's real outcome ("done"/"error") from the
      // batch that actually executed it.
      const existing = byId.get(id);
      if (existing && existing.status !== "cached") continue;
      byId.set(id, nodeResult);
    }
    state.nodes = [...byId.entries()];

    if (result.status !== "done") {
      await this.finishRun(state, result.status, result.error);
      return;
    }
    await this.persistRun(state);
  }

  private handleEmit(state: RunState, e: NodeProgressEvent): void {
    if (e.previewHash) state.produced[e.nodeId] = e.previewHash;
    this.broadcastLocal(e);
  }

  private async finishRun(state: RunState, status: RunStatus, error?: string): Promise<void> {
    if (state.status !== "running") return;
    state.status = status;
    state.error = error;
    state.pending = [];
    await this.persistRun(state);
    this.broadcastLocal({
      runId: state.runId,
      nodeId: "*",
      status: status === "done" ? "done" : "error",
      error,
      at: new Date().toISOString(),
    });
    const waiters = state.waiters;
    state.waiters = [];
    const serialized = serializeRun(state);
    for (const w of waiters) w(serialized);
    this.runs.delete(state.runId);
  }

  private async persistRun(state: RunState): Promise<void> {
    const persisted: PersistedRun = {
      runId: state.runId,
      graph: state.graph,
      quality: state.quality,
      targets: state.targets,
      pending: state.pending,
      produced: state.produced,
      nodes: state.nodes,
      status: state.status,
      error: state.error,
      createdAt: state.createdAt,
    };
    await this.env.DB.prepare(
      "INSERT OR REPLACE INTO runs (id, json, status, created_at) VALUES (?, ?, ?, ?)",
    )
      .bind(state.runId, JSON.stringify(persisted), state.status, persisted.createdAt)
      .run();
    // Keep the table bounded: finished runs older than a week are disposable
    // (their outputs already live in the cache/assets).
    await this.env.DB.prepare(
      "DELETE FROM runs WHERE status != 'running' AND created_at < ?",
    )
      .bind(new Date(Date.now() - RUN_RETENTION_MS).toISOString())
      .run();
  }

  private async loadRun(runId: string): Promise<RunState | undefined> {
    const row = await this.env.DB.prepare("SELECT json FROM runs WHERE id = ?")
      .bind(runId)
      .first<{ json: string }>();
    if (!row) return undefined;
    const p = JSON.parse(row.json) as PersistedRun;
    if (p.status !== "running") return undefined;
    const state: RunState = { ...p, ac: new AbortController(), waiters: [] };
    this.runs.set(runId, state);
    return state;
  }

  /** Re-attach any run left `running` in D1 after an eviction. */
  private async resumeStaleRuns(): Promise<void> {
    const { results } = await this.env.DB.prepare("SELECT id FROM runs WHERE status = 'running'")
      .all<{ id: string }>();
    for (const row of results) {
      if (!this.runs.has(row.id)) await this.loadRun(row.id);
    }
  }

  // ── Training ────────────────────────────────────────────────────────────

  async trainingStart(params: StartTrainingParams): Promise<TrainedLora> {
    const rt = this.runtime();
    const trainer = rt.trainers.require(params.trainerId);
    const apiKey = rt.services.getApiKey?.("fal");
    if (!apiKey) throw new Error("Missing FAL_KEY — set it in the Worker secrets to train.");
    if (params.refHashes.length === 0) throw new Error("No training images selected.");

    const examples = await Promise.all(
      params.refHashes.map(async (hash, i) => {
        const meta = await rt.assets.getMeta(hash);
        const bytes = new Uint8Array(await rt.assets.get(hash));
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

    const id = crypto.randomUUID().slice(0, 8);
    // (1) Intent record — persisted BEFORE any paid call, with an empty handle.
    let record = await rt.library.upsertTrainedLora({
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
    if (params.characterId) await rt.library.patchCharacter(params.characterId, { loraId: id });
    this.broadcastLocal(trainingEvent(record, new Date().toISOString()));

    // (2) Submit (paid). A failure marks the intent record failed, not a dangling job.
    let handle: TrainingHandle;
    try {
      handle = await trainer.submit(input, { apiKey });
    } catch (err) {
      await this.failTraining(id, err instanceof Error ? err.message : String(err));
      throw err;
    }

    // (3) Patch in the durable handle so a wake can resume this exact job.
    record =
      (await rt.library.patchTrainedLora(id, {
        steps: handle.steps,
        jobId: handle.jobId,
        jobEndpoint: handle.endpoint,
        jobStatusUrl: handle.statusUrl,
        jobResponseUrl: handle.responseUrl,
      })) ?? record;
    this.broadcastLocal(trainingEvent(record, new Date().toISOString()));

    await this.env.DB.prepare("INSERT OR REPLACE INTO train_poll (id, polled_at) VALUES (?, ?)")
      .bind(id, Date.now())
      .run();
    this.scheduleAlarm();
    return record;
  }

  async trainingRemove(id: string): Promise<void> {
    await this.runtime().library.removeTrainedLora(id);
    await this.env.DB.prepare("DELETE FROM train_poll WHERE id = ?").bind(id).run();
  }

  /** Poll every due training job once. Returns true when any job is still training. */
  private async trainingTick(): Promise<boolean> {
    const rt = this.runtime();
    const lib = await rt.library.get();
    let active = false;
    for (const rec of lib.trainedLoras) {
      if (rec.status !== TrainingStatus.Training) continue;
      active = true;
      if (!rec.jobId || !rec.jobStatusUrl) continue; // never submitted — unrecoverable
      const meta = await this.env.DB.prepare("SELECT polled_at FROM train_poll WHERE id = ?")
        .bind(rec.id)
        .first<{ polled_at: number }>();
      if (!meta || Date.now() - meta.polled_at < TRAIN_POLL_MS) continue;
      await this.env.DB.prepare("UPDATE train_poll SET polled_at = ? WHERE id = ?")
        .bind(Date.now(), rec.id)
        .run();

      const started = rec.createdAt ? Date.parse(rec.createdAt) : NaN;
      const deadline = (Number.isNaN(started) ? Date.now() : started) + TRAIN_DEADLINE_MS;
      if (Date.now() > deadline) {
        await this.failTraining(rec.id, "training timed out");
        continue;
      }
      const trainer = rt.trainers.get(rec.trainerId);
      const apiKey = rt.services.getApiKey?.("fal");
      // A missing key is transient — never fail a still-running, paid job over it.
      if (!trainer || !apiKey) continue;

      try {
        const poll = await trainer.poll(
          {
            jobId: rec.jobId,
            endpoint: rec.jobEndpoint,
            steps: rec.steps,
            statusUrl: rec.jobStatusUrl,
            responseUrl: rec.jobResponseUrl,
          },
          { apiKey },
        );
        if (poll.status === "ready" && poll.result) {
          await this.completeTraining(rec.id, poll.result.loraUrl, poll.result.configUrl ?? "", poll.result.costUsd);
        } else if (poll.status === "failed") {
          await this.failTraining(rec.id, poll.error ?? "training failed");
        }
      } catch (err) {
        // Fail fast on a TERMINAL fal error; keep polling through transient ones.
        if (err instanceof FalHttpError && err.terminal) {
          await this.failTraining(rec.id, `fal training error ${err.status}: ${err.message}`);
        }
      }
    }
    return active;
  }

  private async completeTraining(
    id: string,
    loraUrl: string,
    configUrl: string,
    costUsd: number,
  ): Promise<void> {
    const rec = await this.runtime().library.patchTrainedLora(id, {
      status: TrainingStatus.Ready,
      loraUrl,
      configUrl,
      costUsd,
    });
    if (rec) this.broadcastLocal(trainingEvent(rec, new Date().toISOString()));
    await this.env.DB.prepare("DELETE FROM train_poll WHERE id = ?").bind(id).run();
  }

  private async failTraining(id: string, error: string): Promise<void> {
    const rec = await this.runtime().library.patchTrainedLora(id, {
      status: TrainingStatus.Failed,
      error,
    });
    if (rec) this.broadcastLocal(trainingEvent(rec, new Date().toISOString()));
    await this.env.DB.prepare("DELETE FROM train_poll WHERE id = ?").bind(id).run();
  }

  // ── Alarm loop ──────────────────────────────────────────────────────────

  override async alarm(): Promise<void> {
    await this.resumeStaleRuns();
    for (const state of [...this.runs.values()]) {
      if (state.status === "running") await this.processBatch(state);
    }
    const trainsActive = await this.trainingTick();
    this.scheduleAlarm(trainsActive);
  }

  private scheduleAlarm(knownTrainsActive?: boolean): void {
    const runsActive = [...this.runs.values()].some((s) => s.status === "running");
    if (runsActive) {
      void this.ctx.storage.setAlarm(Date.now() + RUN_TICK_MS);
      return;
    }
    void (async () => {
      const trainsActive =
        knownTrainsActive ??
        (await this.env.DB.prepare("SELECT COUNT(*) AS n FROM train_poll").first<{ n: number }>())
          ?.n !== 0;
      if (trainsActive) await this.ctx.storage.setAlarm(Date.now() + TRAIN_TICK_MS);
      else await this.ctx.storage.deleteAlarm();
    })();
  }
}

function serializeRun(state: RunState): SerializedRun {
  return {
    runId: state.runId,
    status: state.status,
    error: state.error,
    nodes: state.nodes,
    produced: state.produced,
  };
}
