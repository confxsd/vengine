import { randomUUID } from "node:crypto";
import type { Hono } from "hono";
import { z } from "zod";
import {
  ComicProjectSchema,
  compileComic,
  genNodeId,
  exportNodeId,
  type ComicProject,
  type NodeProgressEvent,
} from "@vengine/shared";
import type { Runtime } from "./runtime.js";

type Broadcast = (event: NodeProgressEvent & { kind?: string }) => void;

const shortId = () => randomUUID().slice(0, 8);

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

/** Mount the Comic Studio routes onto the main Hono app. */
export function registerComicRoutes(app: Hono, rt: Runtime, broadcast: Broadcast): void {
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

  // Compile → run → persist resultHashes.
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
    const runId = randomUUID();
    broadcast({ runId, nodeId: "*", status: "running", at: new Date().toISOString() });

    const result = await rt.executor.run(graph, {
      runId,
      services: rt.services,
      quality: parsed.data.quality,
      targets,
      emit: (e) => broadcast(e),
    });

    // Map generation results back to frames by id; resultHash from the run result
    // (authoritative), not from the live WS stream.
    const frames = project.frames.map((f) => {
      const gen = result.nodes.get(genNodeId(f.id));
      const hash = (gen?.outputs?.image as { hash?: string } | undefined)?.hash;
      return hash ? { ...f, resultHash: hash } : f;
    });
    const saved = await rt.projects.save({ ...project, frames });

    return c.json({
      runId: result.runId,
      status: result.status,
      error: result.error,
      frames: saved.frames.map((f) => ({ id: f.id, resultHash: f.resultHash })),
    });
  });

  // Upload an image (e.g. a style anchor) into the content-addressed asset store.
  app.post("/api/assets", async (c) => {
    const body = await c.req.parseBody();
    const file = body.file;
    if (!(file instanceof File)) return c.json({ error: "expected a 'file' field" }, 400);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const ref = await rt.assets.put(bytes, file.type || "application/octet-stream");
    return c.json(ref, 201);
  });
}
