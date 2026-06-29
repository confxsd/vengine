import { randomUUID } from "node:crypto";
import type { Hono } from "hono";
import { z } from "zod";
import {
  ComicProjectSchema,
  compileComic,
  compileEditFrame,
  genNodeId,
  exportNodeId,
  frameIdFromNodeId,
  unionVariants,
  type ComicProject,
  type NodeProgressEvent,
} from "@vengine/shared";
import type { Runtime } from "./runtime.js";

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

/** Mount the Comic Studio routes onto the main Hono app. */
export function registerComicRoutes(app: Hono, rt: Runtime, broadcast: Broadcast): void {
  /** In-flight runs, so a client can cancel one by runId (stops paid spend). */
  const runs = new Map<string, AbortController>();

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

    const graph = compileComic(project, { exportDir: rt.projects.framesDir(id) });
    const targets = parsed.data.frameIds?.map(exportNodeId);
    // The seed actually compiled for each frame, recorded with its variant so a
    // re-selected variant is reproducible.
    const seedByFrame = new Map(project.frames.map((f) => [f.id, f.seed ?? project.style.seed]));

    const runId = randomUUID();
    const ac = new AbortController();
    runs.set(runId, ac);
    broadcast({ runId, nodeId: "*", status: "running", at: new Date().toISOString() });

    // Capture hashes as they stream so a cancelled/failed run still persists the
    // frames that did finish (their bytes are already in the asset store).
    const produced = new Map<string, string>();
    const onEmit = (e: NodeProgressEvent) => {
      const frameId = frameIdFromNodeId(e.nodeId);
      if (frameId && e.nodeId.startsWith("gen-") && e.previewHash) produced.set(frameId, e.previewHash);
      broadcast(e);
    };

    let result;
    try {
      result = await rt.executor.run(graph, {
        runId,
        services: rt.services,
        quality: parsed.data.quality,
        targets,
        emit: onEmit,
        signal: ac.signal,
      });
    } finally {
      runs.delete(runId);
    }

    // Prefer the authoritative run result; fall back to streamed hashes for any
    // frame that finished after an early stop.
    for (const f of project.frames) {
      const fromResult = (result.nodes.get(genNodeId(f.id))?.outputs?.image as { hash?: string } | undefined)
        ?.hash;
      const hash = fromResult ?? produced.get(f.id);
      if (hash) produced.set(f.id, hash);
    }

    // Apply the delta to the *latest* document under the store lock, so edits made
    // during a long run are preserved (only variants/resultHash change).
    let saved = project;
    try {
      saved = await rt.projects.update(id, (latest) => ({
        ...latest,
        frames: latest.frames.map((f) => {
          const hash = produced.get(f.id);
          if (!hash) return f;
          const seed = seedByFrame.get(f.id) ?? latest.style.seed;
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

    broadcast({
      runId,
      nodeId: "*",
      status: result.status === "done" ? "done" : "error",
      error: result.error,
      at: new Date().toISOString(),
    });

    // Distinguish freshly generated frames from cache hits, so the client can tell the
    // user when a run was a no-op (identical inputs → same image) and point them to
    // reroll the seed for a new take instead of looking like nothing happened.
    const scope = parsed.data.frameIds ?? project.frames.map((f) => f.id);
    let generated = 0;
    let cached = 0;
    for (const fid of scope) {
      const st = result.nodes.get(genNodeId(fid))?.status;
      if (st === "done") generated += 1;
      else if (st === "cached") cached += 1;
    }

    return c.json({
      runId: result.runId,
      status: result.status,
      error: result.error,
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
    const ac = new AbortController();
    runs.set(runId, ac);
    broadcast({ runId, nodeId: "*", status: "running", at: new Date().toISOString() });

    // Capture the streamed hash so a finished-then-stopped edit still persists.
    let produced: string | undefined;
    const onEmit = (e: NodeProgressEvent) => {
      if (e.nodeId === gid && e.previewHash) produced = e.previewHash;
      broadcast(e);
    };

    let result;
    try {
      result = await rt.executor.run(graph, {
        runId,
        services: rt.services,
        quality: req.quality,
        targets: [gid],
        emit: onEmit,
        signal: ac.signal,
      });
    } finally {
      runs.delete(runId);
    }

    const hash =
      (result.nodes.get(gid)?.outputs?.image as { hash?: string } | undefined)?.hash ?? produced;

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
  app.post("/api/runs/:runId/cancel", (c) => {
    const ac = runs.get(c.req.param("runId"));
    if (!ac) return c.json({ error: "no such run" }, 404);
    ac.abort();
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
