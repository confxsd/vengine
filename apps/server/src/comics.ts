import { randomUUID } from "node:crypto";
import type { Hono } from "hono";
import { z } from "zod";
import {
  ComicProjectSchema,
  compileComic,
  compileEditFrame,
  frameImageHash,
  genNodeId,
  exportNodeId,
  unionVariants,
  type ComicFrame,
  type ComicProject,
  type NodeProgressEvent,
} from "@vengine/shared";
import type { Runtime } from "./runtime.js";
import type { RunHost } from "./run-host.js";

type Broadcast = (event: NodeProgressEvent & { kind?: string }) => void;

const shortId = () => randomUUID().slice(0, 8);
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/** A fresh comic with a few empty frames to start from. */
function newProject(name?: string): ComicProject {
  const now = new Date().toISOString();
  return ComicProjectSchema.parse({
    id: shortId(),
    name: name?.trim() || "Untitled comic",
    frames: Array.from({ length: 4 }, () => ({ id: shortId(), prompt: "" })),
    createdAt: now,
    updatedAt: now,
  });
}

const RunBody = z.object({
  quality: z.enum(["preview", "final"]).optional(),
  /** Subset of frames to (re)generate; omitted = all frames. */
  frameIds: z.array(z.string()).optional(),
});

/** In-place edit of one frame's image (instruction-driven image-to-image). */
const EditBody = z.object({
  /** The image to edit — a hash already in the asset store (a variant or an upload). */
  baseHash: z.string().length(64),
  /** What to change. */
  instruction: z.string().default(""),
  /** How freely to deviate from the base image. */
  mode: z.enum(["tweak", "restage"]).optional(),
  /** Carry the project's style refs + active cast as secondary references. */
  keepStyle: z.boolean().optional(),
  /** Per-edit seed (a fresh roll explores; a fixed value reproduces). */
  seed: z.number().int().optional(),
  quality: z.enum(["preview", "final"]).optional(),
});

/**
 * Partition the selected frames into dependency waves (spec EPISODE_STUDIO §7) so
 * a continuation — or an echo — always compiles against its source's FINISHED
 * image: references resolve at compile time, and frames in one run are DAG
 * siblings, so an un ordered "generate all" would feed a continuation a missing
 * or stale prior. A frame is ready when its `continuesFrameId`/`echoFrameId` is
 * unset, points outside the selection, or at a frame that already has an image
 * (now, or scheduled in an earlier wave — the simulation matches reality because
 * every scheduled frame persists its image before the next wave compiles).
 * Independent frames stay concurrent within a wave. Cycles (impossible via
 * strictly-earlier validation, but defensive) and any other deadlock fall
 * through to a final wave — unresolved links are dropped at compile exactly as
 * today, so a run never breaks. Pure, so the partitioning is unit-testable.
 */
export function partitionWaves(
  project: ComicProject,
  frameIds: readonly string[],
): ComicFrame[][] {
  const selected = new Set(frameIds);
  const hasImage = new Set(
    project.frames.filter((f) => frameImageHash(f)).map((f) => f.id),
  );
  const scheduled = new Set<string>();
  const waves: ComicFrame[][] = [];
  let pending = project.frames.filter((f) => selected.has(f.id));
  while (pending.length > 0) {
    const pendingIds = new Set(pending.map((f) => f.id));
    const ready = pending.filter((f) =>
      [f.continuesFrameId, f.echoFrameId].every(
        (dep) =>
          !dep || dep === f.id || !pendingIds.has(dep) || hasImage.has(dep) || scheduled.has(dep),
      ),
    );
    const wave = ready.length > 0 ? ready : pending; // deadlock → run the rest together
    waves.push(wave);
    for (const f of wave) scheduled.add(f.id);
    const waveIds = new Set(wave.map((f) => f.id));
    pending = pending.filter((f) => !waveIds.has(f.id));
  }
  return waves;
}

/**
 * Mount the Comic Studio routes onto the main Hono app. Runs execute through
 * the shared `RunHost`, so the single cancel endpoint can stop any generation
 * by runId regardless of which feature started it.
 */
export function registerComicRoutes(
  app: Hono,
  rt: Runtime,
  broadcast: Broadcast,
  runHost: RunHost,
): void {

  // List projects (for the switcher).
  app.get("/api/comics", async (c) => c.json(await rt.projects.list()));

  // Create a project.
  app.post("/api/comics", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const saved = await rt.projects.save(newProject(typeof body?.name === "string" ? body.name : undefined));
    return c.json(saved, 201);
  });

  // Load a project.
  app.get("/api/comics/:id", async (c) => {
    try {
      return c.json(await rt.projects.get(c.req.param("id")));
    } catch {
      return c.json({ error: "not found" }, 404);
    }
  });

  // Save (autosave). resultHash is preserved server-side by the store's merge.
  app.put("/api/comics/:id", async (c) => {
    const parsed = ComicProjectSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    if (parsed.data.id !== c.req.param("id")) return c.json({ error: "id mismatch" }, 400);
    return c.json(await rt.projects.save(parsed.data));
  });

  // Delete a single generated image (variant) from a frame. Generation outputs are
  // merge-protected on save, so dropping one needs an explicit read-modify-write.
  app.delete("/api/comics/:id/frames/:frameId/variants/:hash", async (c) => {
    const frameId = c.req.param("frameId");
    const hash = c.req.param("hash");
    try {
      const saved = await rt.projects.update(c.req.param("id"), (project) => ({
        ...project,
        frames: project.frames.map((f) => {
          if (f.id !== frameId) return f;
          const variants = f.variants.filter((v) => v.hash !== hash);
          // If the deleted image was the selection, fall back to the newest remaining.
          const resultHash = f.resultHash === hash ? variants.at(-1)?.hash : f.resultHash;
          return { ...f, variants, resultHash };
        }),
      }));
      const frame = saved.frames.find((f) => f.id === frameId);
      if (!frame) return c.json({ error: "frame not found" }, 404);
      return c.json({ id: frame.id, resultHash: frame.resultHash, variants: frame.variants });
    } catch {
      return c.json({ error: "not found" }, 404);
    }
  });

  // Snapshot the current state.
  app.post("/api/comics/:id/snapshot", async (c) => {
    try {
      return c.json(await rt.projects.createSnapshot(c.req.param("id")), 201);
    } catch {
      return c.json({ error: "not found" }, 404);
    }
  });

  app.get("/api/comics/:id/snapshots", async (c) =>
    c.json(await rt.projects.listSnapshots(c.req.param("id"))),
  );

  // Dry-run cost estimate (confirm-before-spend).
  app.post("/api/comics/:id/plan", async (c) => {
    const id = c.req.param("id");
    const parsed = RunBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    let project: ComicProject;
    try {
      project = await rt.projects.get(id);
    } catch {
      return c.json({ error: "not found" }, 404);
    }
    const graph = compileComic(project, { exportDir: rt.projects.framesDir(id) });
    const targets = parsed.data.frameIds?.map(exportNodeId);
    const plan = await rt.executor.plan(graph, { quality: parsed.data.quality, targets });
    return c.json(plan);
  });

  // Compile → run → persist freshly generated images into each frame's variants.
  // Runs execute in dependency WAVES (spec EPISODE_STUDIO §7): each wave is the
  // regular runHost path on a freshly compiled graph, its outputs are persisted
  // before the next wave compiles, so a continuation (or echo) always resolves
  // its source's finished image. Unchanged frames are content-addressed cache
  // hits, so the per-wave recompile costs nothing (run twice → second run free).
  app.post("/api/comics/:id/run", async (c) => {
    const id = c.req.param("id");
    const parsed = RunBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    let project: ComicProject;
    try {
      project = await rt.projects.get(id);
    } catch {
      return c.json({ error: "not found" }, 404);
    }

    const scope = parsed.data.frameIds ?? project.frames.map((f) => f.id);
    const waves = partitionWaves(project, scope);
    // The seed actually compiled for each frame, recorded with its variant so a
    // re-selected variant is reproducible.
    const seedByFrame = new Map(project.frames.map((f) => [f.id, f.seed ?? project.style.seed]));

    const runId = randomUUID();
    broadcast({ runId, nodeId: "*", status: "running", at: new Date().toISOString() });

    // Accumulated across waves: produced image hashes and terminal node statuses.
    const produced: Record<string, string> = {};
    const nodeStatus = new Map<string, "done" | "cached">();
    let status = "done";
    let error: string | undefined;

    for (const wave of waves) {
      // Compile against the LATEST persisted document so this wave's references
      // resolve the images the previous wave just wrote (fall back to the snapshot
      // we already hold if the project vanished mid-run).
      let latest = project;
      try {
        latest = await rt.projects.get(id);
      } catch {
        /* project vanished mid-run — keep compiling the snapshot we hold */
      }
      const graph = compileComic(latest, { exportDir: rt.projects.framesDir(id) });
      const targets = wave.map((f) => exportNodeId(f.id));

      // The RunHost captures streamed preview hashes (its `produced` map), so a
      // cancelled/failed wave still persists the frames that did finish.
      const result = await runHost.run(runId, {
        graph,
        quality: parsed.data.quality,
        targets,
        emit: broadcast,
      });

      // Prefer the authoritative run result; fall back to streamed hashes for any
      // frame that finished after an early stop.
      const waveProduced = new Map<string, string>();
      for (const f of wave) {
        const gid = genNodeId(f.id);
        const fromResult =
          (result.nodes.get(gid)?.outputs?.image as { hash?: string } | undefined)?.hash;
        const hash = fromResult ?? result.produced[gid];
        if (hash) {
          produced[gid] = hash;
          waveProduced.set(f.id, hash);
        }
        const st = result.nodes.get(gid)?.status;
        if (st === "done") nodeStatus.set(gid, "done");
        else if (st === "cached") nodeStatus.set(gid, "cached");
      }

      // Apply this wave's delta to the *latest* document under the store lock, so
      // edits made during a long run are preserved (only variants/resultHash change)
      // and the NEXT wave's compile sees the fresh images.
      try {
        await rt.projects.update(id, (cur) => ({
          ...cur,
          frames: cur.frames.map((f) => {
            const hash = waveProduced.get(f.id);
            if (!hash) return f;
            const seed = seedByFrame.get(f.id) ?? cur.style.seed;
            return {
              ...f,
              resultHash: hash,
              variants: unionVariants(f.variants, [{ hash, seed }]),
            };
          }),
        }));
      } catch {
        /* project vanished mid-run — nothing to persist */
      }

      if (result.status !== "done") {
        status = result.status;
        error = result.error;
        break;
      }
    }

    broadcast({
      runId,
      nodeId: "*",
      status: status === "done" ? "done" : "error",
      error,
      at: new Date().toISOString(),
    });

    // Distinguish freshly generated frames from cache hits, so the client can tell the
    // user when a run was a no-op (identical inputs → same image) and point them to
    // reroll the seed for a new take instead of looking like nothing happened.
    let generated = 0;
    let cached = 0;
    for (const fid of scope) {
      const st = nodeStatus.get(genNodeId(fid));
      if (st === "done") generated += 1;
      else if (st === "cached") cached += 1;
    }

    let saved = project;
    try {
      saved = await rt.projects.get(id);
    } catch {
      /* project vanished — report the snapshot we hold */
    }

    return c.json({
      runId,
      status,
      error,
      generated,
      cached,
      frames: saved.frames.map((f) => ({ id: f.id, resultHash: f.resultHash, variants: f.variants })),
    });
  });

  // Edit one frame's image in place: compile a single-node edit graph (the base
  // image leads the reference set, the instruction drives an edit-capable model),
  // run it, and persist the result as a new — selected — variant of that frame.
  // Shares the run plumbing (runId/cancel, "*" brackets, WS preview routing) so the
  // edit streams a live preview to the frame exactly like a normal generation.
  app.post("/api/comics/:id/frames/:frameId/edit", async (c) => {
    const id = c.req.param("id");
    const frameId = c.req.param("frameId");
    const parsed = EditBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);

    let project: ComicProject;
    try {
      project = await rt.projects.get(id);
    } catch {
      return c.json({ error: "not found" }, 404);
    }
    const frame = project.frames.find((f) => f.id === frameId);
    if (!frame) return c.json({ error: "frame not found" }, 404);

    const req = parsed.data;
    const graph = compileEditFrame(project, frame, req);
    const gid = genNodeId(frameId);
    // Record the seed actually compiled, so a re-selected edit variant reproduces.
    const seed = req.seed ?? frame.seed ?? project.style.seed;

    const runId = randomUUID();
    broadcast({ runId, nodeId: "*", status: "running", at: new Date().toISOString() });

    // The RunHost captures the streamed hash, so a finished-then-stopped edit
    // still persists (its bytes are already in the asset store).
    const result = await runHost.run(runId, {
      graph,
      quality: req.quality,
      targets: [gid],
      emit: broadcast,
    });
    const produced = result.produced;

    const hash =
      (result.nodes.get(gid)?.outputs?.image as { hash?: string } | undefined)?.hash ??
      produced[gid];

    let saved = project;
    if (hash) {
      try {
        saved = await rt.projects.update(id, (latest) => ({
          ...latest,
          frames: latest.frames.map((f) =>
            f.id === frameId
              ? { ...f, resultHash: hash, variants: unionVariants(f.variants, [{ hash, seed }]) }
              : f,
          ),
        }));
      } catch {
        /* project vanished mid-edit — nothing to persist */
      }
    }

    broadcast({
      runId,
      nodeId: "*",
      status: result.status === "done" ? "done" : "error",
      error: result.error,
      at: new Date().toISOString(),
    });

    const out = saved.frames.find((f) => f.id === frameId);
    return c.json({
      runId: result.runId,
      status: result.status,
      error: result.error,
      frame: out ? { id: out.id, resultHash: out.resultHash, variants: out.variants } : null,
    });
  });

  // Cancel an in-flight run (the client learns runId from the "*" start event).
  app.post("/api/runs/:runId/cancel", async (c) => {
    const ok = await runHost.cancel(c.req.param("runId"));
    if (!ok) return c.json({ error: "no such run" }, 404);
    return c.json({ ok: true });
  });

  // Upload an image (e.g. a style anchor) into the content-addressed asset store.
  app.post("/api/assets", async (c) => {
    const body = await c.req.parseBody();
    const file = body.file;
    if (!(file instanceof File)) return c.json({ error: "expected a 'file' field" }, 400);
    if (!file.type.startsWith("image/")) return c.json({ error: "expected an image file" }, 400);
    if (file.size > MAX_UPLOAD_BYTES) return c.json({ error: "image too large (max 25 MB)" }, 413);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const ref = await rt.assets.put(bytes, file.type);
    return c.json(ref, 201);
  });
}
