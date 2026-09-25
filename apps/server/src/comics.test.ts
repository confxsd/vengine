import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { Executor } from "@vengine/core";
import { mockModel, ProviderRegistry } from "@vengine/providers";
import { createNodeRegistry } from "@vengine/nodes";
import { AssetStore, FileOutputCache, ProjectStore } from "@vengine/storage";
import {
  ComicFrameSchema,
  ComicProjectSchema,
  genNodeId,
  type ComicProject,
  type NodeProgressEvent,
} from "@vengine/shared";
import { NodeRunHost } from "./node-run-host.js";
import { partitionWaves, registerComicRoutes } from "./comics.js";
import type { RunHost, RunHostRequest, RunResultWithProduced } from "./run-host.js";
import type { Runtime } from "./runtime.js";

function project(overrides: Record<string, unknown> = {}): ComicProject {
  return ComicProjectSchema.parse({
    id: "p1",
    name: "Waves",
    frames: [
      { id: "a", prompt: "1" },
      { id: "b", prompt: "2" },
      { id: "c", prompt: "3" },
      { id: "d", prompt: "4" },
    ],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  });
}

/** Wave schedule as frame-id lists (the readable form of the assertions below). */
const ids = (waves: ReturnType<typeof partitionWaves>) => waves.map((w) => w.map((f) => f.id));

describe("partitionWaves (the wave runner's schedule, spec EPISODE_STUDIO §7)", () => {
  it("interleaved case: [1,2,3] then [4] when frame 4 continues frame 1", () => {
    const p = project({
      frames: [
        { id: "a", prompt: "1" },
        { id: "b", prompt: "2" },
        { id: "c", prompt: "3" },
        { id: "d", prompt: "4", continuesFrameId: "a" },
      ],
    });
    expect(ids(partitionWaves(p, ["a", "b", "c", "d"]))).toEqual([["a", "b", "c"], ["d"]]);
  });

  it("a chain serializes: each continuation waits for its source's wave", () => {
    const p = project({
      frames: [
        { id: "a", prompt: "1" },
        { id: "b", prompt: "2", continuesFrameId: "a" },
        { id: "c", prompt: "3", continuesFrameId: "b" },
        { id: "d", prompt: "4", continuesFrameId: "c" },
      ],
    });
    expect(ids(partitionWaves(p, ["a", "b", "c", "d"]))).toEqual([["a"], ["b"], ["c"], ["d"]]);
  });

  it("independent frames share ONE wave — only linked chains serialize", () => {
    expect(ids(partitionWaves(project(), ["a", "b", "c", "d"]))).toEqual([["a", "b", "c", "d"]]);
  });

  it("a source that already has an image unblocks its continuation in the same wave", () => {
    const img = "d".repeat(64);
    const p = project({
      frames: [
        { id: "a", prompt: "1", resultHash: img },
        { id: "b", prompt: "2" },
        { id: "c", prompt: "3" },
        { id: "d", prompt: "4", continuesFrameId: "a" },
      ],
    });
    expect(ids(partitionWaves(p, ["a", "b", "c", "d"]))).toEqual([["a", "b", "c", "d"]]);
  });

  it("a fully generated episode re-runs as a single wave (unchanged frames are cache hits)", () => {
    // Re-running compiles identical inputs, so the content-addressed cache makes
    // every frame free; the schedule must not split what doesn't need to wait.
    const img = "e".repeat(64);
    const p = project({
      frames: [
        { id: "a", prompt: "1", resultHash: img },
        { id: "b", prompt: "2", resultHash: "f".repeat(64) },
        { id: "c", prompt: "3", resultHash: "1".repeat(64) },
        { id: "d", prompt: "4", continuesFrameId: "a", resultHash: img },
      ],
    });
    expect(ids(partitionWaves(p, ["a", "b", "c", "d"]))).toEqual([["a", "b", "c", "d"]]);
  });

  it("an echo dependency waits for its source like a continuation (the bookend payout)", () => {
    const p = project({
      frames: [
        { id: "a", prompt: "1" },
        { id: "b", prompt: "2" },
        { id: "c", prompt: "3" },
        { id: "d", prompt: "4", echoFrameId: "a" },
      ],
    });
    expect(ids(partitionWaves(p, ["a", "b", "c", "d"]))).toEqual([["a", "b", "c"], ["d"]]);
  });

  it("links outside the selection never block a subset run", () => {
    const p = project({
      frames: [
        { id: "a", prompt: "1" },
        { id: "b", prompt: "2" },
        { id: "c", prompt: "3" },
        { id: "d", prompt: "4", continuesFrameId: "a" }, // source NOT in this run
      ],
    });
    expect(ids(partitionWaves(p, ["d"]))).toEqual([["d"]]);
  });

  it("unknown frame ids in the request are ignored", () => {
    expect(ids(partitionWaves(project(), ["a", "ghost"]))).toEqual([["a"]]);
    expect(partitionWaves(project(), [])).toEqual([]);
  });

  it("a defensive cycle falls through to a final wave — a run never breaks", () => {
    // Impossible via strictly-earlier validation, but a hand-edited document
    // could contain one; the remainder runs together and compile drops the
    // unresolved links exactly as `continuityReferences` does today.
    const p = project({
      frames: [
        { id: "a", prompt: "1" },
        { id: "b", prompt: "2", continuesFrameId: "d" },
        { id: "c", prompt: "3" },
        { id: "d", prompt: "4", continuesFrameId: "b" },
      ],
    });
    expect(ids(partitionWaves(p, ["a", "b", "c", "d"]))).toEqual([["a", "c"], ["b", "d"]]);
  });

  it("a frame with BOTH dependencies waits for the later of the two", () => {
    // The both-set case (echo governs composition, but both images are fed):
    // readiness must require EVERY dependency, not just the first.
    const p = project({
      frames: [
        { id: "a", prompt: "1" },
        { id: "b", prompt: "2" },
        { id: "c", prompt: "3", continuesFrameId: "a", echoFrameId: "b" },
        { id: "d", prompt: "4", continuesFrameId: "b" },
      ],
    });
    expect(ids(partitionWaves(p, ["a", "b", "c", "d"]))).toEqual([["a", "b"], ["c", "d"]]);
  });

  it("self-links never block a frame (compile drops them as junk)", () => {
    const p = project({
      frames: [
        { id: "a", prompt: "1", continuesFrameId: "a", echoFrameId: "a" },
        { id: "b", prompt: "2" },
      ],
    });
    expect(ids(partitionWaves(p, ["a", "b"]))).toEqual([["a", "b"]]);
  });
});

// ---------------------------------------------------------------------------
// Route-level integration — the real handler loop over REAL stores and the REAL
// executor on the offline mock image model, so the §13 wave acceptance bullets
// ("persist before the next wave compiles", "run twice → second run free",
// "unresolved links never error", cancel) are exercised against the actual code
// path, not just the pure schedule.
// ---------------------------------------------------------------------------

/** The full route surface over temp-dir stores + the offline mock image model. */
function harness(runHost?: RunHost) {
  const root = mkdtempSync(join(tmpdir(), "vengine-comics-"));
  const projects = new ProjectStore({ root: join(root, "projects") });
  const assets = new AssetStore({ root: join(root, "assets") });
  const rt = {
    projects,
    assets,
    providers: new ProviderRegistry().register(mockModel),
    executor: new Executor({
      registry: createNodeRegistry({ providers: new ProviderRegistry().register(mockModel) }),
      cache: new FileOutputCache({ root: join(root, "cache") }),
      concurrency: 4,
    }),
    services: { assets, getApiKey: () => undefined },
  } as unknown as Runtime;
  const app = new Hono();
  const events: NodeProgressEvent[] = [];
  registerComicRoutes(app, rt, (e) => events.push(e as NodeProgressEvent), runHost ?? new NodeRunHost(rt));
  return { app, rt, events };
}

/** JSON POST request-init (Hono's `app.request` takes a plain RequestInit). */
const post = (body?: unknown): RequestInit => ({
  method: "POST",
  ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
});

/** Create a project on the app and replace its frames (as a draft apply would). */
async function seedEpisode(app: Hono, frames: ComicProject["frames"]): Promise<string> {
  const createdRes = await app.request("/api/comics", post({}));
  const created = (await createdRes.json()) as ComicProject;
  const res = await app.request(`/api/comics/${created.id}`, {
    method: "PUT",
    body: JSON.stringify(ComicProjectSchema.parse({ ...created, frames })),
    headers: { "content-type": "application/json" },
  });
  const saved = (await res.json()) as ComicProject;
  return saved.id;
}

interface RunResponse {
  status: string;
  error?: string;
  generated: number;
  cached: number;
  frames: { id: string; resultHash?: string }[];
}

describe("POST /api/comics/:id/run — the wave loop end-to-end (offline mock model)", () => {
  it("runs [a,b,c] then [d] — wave 1 persists before wave 2 compiles — and re-running is all cache hits", async () => {
    const { app, events } = harness();
    const frames = [
      { id: "a", prompt: "the plaza" },
      { id: "b", prompt: "the crowd" },
      { id: "c", prompt: "the turn" },
      { id: "d", prompt: "the close", continuesFrameId: "a" },
    ].map((f) => ComicFrameSchema.parse(f));
    const id = await seedEpisode(app, frames);

    const first = await app.request(`/api/comics/${id}/run`, post());
    expect(first.status).toBe(200);
    const run1 = (await first.json()) as RunResponse;
    expect(run1.status).toBe("done");
    expect(run1.generated).toBe(4);
    expect(run1.cached).toBe(0);
    expect(run1.frames.every((f) => f.resultHash)).toBe(true);

    // Wave serialization is observable in the event stream: wave-1 nodes are DONE
    // before wave-2's node starts (the loop awaits each wave and persists between).
    const nodeOrder = events.map((e) => e.nodeId);
    const lastWave1Done = Math.max(...["a", "b", "c"].map((f) => nodeOrder.lastIndexOf(genNodeId(f))));
    const firstD = nodeOrder.indexOf(genNodeId("d"));
    expect(firstD).toBeGreaterThan(lastWave1Done);

    // Second run: identical inputs → content-addressed cache hits, same images.
    const second = await app.request(`/api/comics/${id}/run`, post());
    const run2 = (await second.json()) as RunResponse;
    expect(run2.status).toBe("done");
    expect(run2.generated).toBe(0);
    expect(run2.cached).toBe(4);
    expect(run2.frames.map((f) => f.resultHash)).toEqual(run1.frames.map((f) => f.resultHash));
  }, 30_000);

  it("a link to a deleted frame never errors — it runs and renders", async () => {
    const { app } = harness();
    const id = await seedEpisode(app, [ComicFrameSchema.parse({ id: "a", prompt: "solo", continuesFrameId: "ghost" })]);
    const res = await app.request(`/api/comics/${id}/run`, post());
    const run = (await res.json()) as RunResponse;
    expect(run.status).toBe("done");
    expect(run.generated).toBe(1);
    expect(run.frames[0]!.resultHash).toBeTruthy();
  }, 30_000);

  it("cancel mid-wave: nothing partial persists; a re-run completes", async () => {
    // A stub RunHost whose first run hangs after frame a produced an image, so the
    // cancel path (persist-what-finished, stop, report) is deterministic.
    const hashA = "c".repeat(64);
    const controllers = new Map<string, AbortController>();
    let hang = true;
    const allDone = (runId: string): RunResultWithProduced => {
      const nodes = new Map(
        ["a", "b", "c", "d"].map((f) => [
          genNodeId(f),
          { nodeId: genNodeId(f), status: "done" as const, outputs: { image: { hash: `${f}`.repeat(64) } } },
        ]),
      );
      return {
        runId,
        status: "done",
        nodes,
        produced: Object.fromEntries(["a", "b", "c", "d"].map((f) => [genNodeId(f), `${f}`.repeat(64)])),
      };
    };
    const stub: RunHost = {
      async run(runId, req) {
        if (!hang) return allDone(runId);
        return new Promise((resolve) => {
          const ac = new AbortController();
          controllers.set(runId, ac);
          ac.signal.addEventListener("abort", () =>
            resolve({
              runId,
              status: "cancelled",
              nodes: new Map(),
              produced: { [genNodeId("a")]: hashA },
            }),
          );
          // Frame a's bytes land in the asset store (the streamed preview hash)
          // before the cancel arrives — the run loop must persist what finished.
          req.emit({ runId, nodeId: genNodeId("a"), status: "running", previewHash: hashA, at: new Date().toISOString() });
        });
      },
      async cancel(runId) {
        const ac = controllers.get(runId);
        hang = false;
        ac?.abort();
        return !!ac;
      },
    };
    const { app, events } = harness(stub);
    const id = await seedEpisode(app, ["a", "b", "c", "d"].map((f) => ComicFrameSchema.parse({ id: f, prompt: f })));

    const runPromise = app.request(`/api/comics/${id}/run`, post());
    // Wait until the stub's first wave has actually STARTED (its controller is
    // registered and frame a's preview hash streamed) — cancelling earlier would
    // race the handler before run() is even entered.
    for (let i = 0; i < 100 && !events.some((e) => e.nodeId === genNodeId("a")); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const runId = events.find((e) => e.nodeId === "*")!.runId;
    const cancel = await app.request(`/api/runs/${runId}/cancel`, post());
    expect(cancel.status).toBe(200);
    const run1 = (await (await runPromise).json()) as RunResponse;
    expect(run1.status).toBe("cancelled");
    // The finished frame persisted; nothing partial — every other frame untouched.
    expect(run1.frames.find((f) => f.id === "a")!.resultHash).toBe(hashA);
    expect(run1.frames.filter((f) => f.id !== "a").every((f) => !f.resultHash)).toBe(true);

    // Re-run completes the episode.
    const run2 = (await (await app.request(`/api/comics/${id}/run`, post())).json()) as RunResponse;
    expect(run2.status).toBe("done");
    expect(run2.frames.every((f) => f.resultHash)).toBe(true);
  });
});
