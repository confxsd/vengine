import { randomUUID } from "node:crypto";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import {
  GraphDocumentSchema,
  builtinStylePacks,
  type NodeProgressEvent,
  type TrainingProgressEvent,
} from "@vengine/shared";
import { registerComicRoutes } from "../../server/src/comics.js";
import { registerStudyRoutes } from "../../server/src/studies.js";
import { registerAssistRoutes } from "../../server/src/assist.js";
import { registerDraftRoutes } from "../../server/src/draft.js";
import { registerLibraryRoutes } from "../../server/src/library.js";
import { registerSceneRoutes } from "../../server/src/scenes.js";
import { createRuntime, modelManifest, nodeManifest } from "./runtime.js";
import type { Runtime } from "./runtime.js";
import { DoRunHost } from "./run-host.js";
import { DoTrainingHost } from "./training-host.js";
import { FEED_ID, FeedDo, type SerializedRun } from "./feed-do.js";
import type { Env } from "./env.js";

export { FeedDo };

const IMMUTABLE = "public, max-age=31536000, immutable";

const RunBody = z.object({
  graph: GraphDocumentSchema,
  quality: z.enum(["preview", "final"]).optional(),
  targets: z.array(z.string()).optional(),
});

/**
 * The worker's route app + engine wiring, built once per isolate (bindings and
 * secrets are stable within a deployment). Heavy work lives in the Feed DO;
 * inline routes here are thin — cheap D1/R2 I/O only.
 */
function createApp(env: Env): Hono {
  const rt = createRuntime({ db: env.DB, media: env.MEDIA, env });
  const runHost = new DoRunHost(env);
  const trainingHost = new DoTrainingHost(env);
  const feed = () => env.FEED.get(env.FEED.idFromName(FEED_ID));
  const broadcast = async (event: NodeProgressEvent | TrainingProgressEvent) => {
    try {
      await feed().broadcast(event);
    } catch {
      /* best-effort: events are hints; the persisted store is source of truth */
    }
  };

  // Plain Hono app — the shared route modules type against `Hono` without a
  // bindings generic. Worker bindings are read via `c.env as Env`.
  const app = new Hono();
  app.use("/api/*", cors());

  app.get("/api/health", (c) => c.json({ ok: true }));
  app.get("/api/models", (c) => c.json(modelManifest(rt.providers)));
  app.get("/api/nodes", (c) => c.json(nodeManifest(rt.registry)));

  // Comic Studio: project CRUD, snapshots, compile-and-run, asset upload.
  registerComicRoutes(app, rt, broadcast, runHost);

  // Character System: per-character design studies (generate / refine / curate).
  registerStudyRoutes(app, rt, broadcast, runHost);

  // AI text assist: optimize/enrich/fix prompts and prose fields.
  registerAssistRoutes(app, rt);

  // Draft import: parse a free-form story draft into a reviewable storyboard.
  registerDraftRoutes(app, rt);

  // Seed the built-in style packs (Comic / Oil / Ink / Watercolor) once per
  // isolate when the library is still empty. Registered before the library
  // routes so it runs ahead of the GET.
  let seeded = false;
  app.use("/api/library", async (c, next) => {
    if (!seeded) {
      try {
        const lib = await rt.library.get();
        if (lib.styles.length === 0) await rt.library.ensureStyles(builtinStylePacks());
        seeded = true;
      } catch {
        /* retry on a later request */
      }
    }
    await next();
  });

  // Cross-project Library (characters, style packs) + durable LoRA training.
  registerLibraryRoutes(app, rt, broadcast, trainingHost);

  // Scene understanding: describe a reference image into a reusable breakdown.
  registerSceneRoutes(app, rt);
  // Dry-run cost estimate (confirm-before-spend).
  app.post("/api/plan", async (c) => {
    const parsed = RunBody.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    try {
      const plan = await rt.executor.plan(parsed.data.graph, {
        quality: parsed.data.quality,
        targets: parsed.data.targets,
      });
      return c.json(plan);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  // Run a graph to completion. Executes inside the Feed DO (batched across
  // alarm invocations so a full run fits the free-plan subrequest budget);
  // this request stays open until the run finishes, exactly like the local
  // server.
  app.post("/api/run", async (c) => {
    const parsed = RunBody.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);

    const runId = randomUUID();
    await broadcast({ runId, nodeId: "*", status: "running", at: new Date().toISOString() });

    const result = await runHost.run(runId, {
      graph: parsed.data.graph,
      quality: parsed.data.quality,
      targets: parsed.data.targets,
      emit: broadcast,
    });

    const nodes = Object.fromEntries(result.nodes);
    return c.json({ runId: result.runId, status: result.status, error: result.error, nodes });
  });

  // Resync a run's persisted result (e.g. after a dropped long-poll).
  app.get("/api/runs/:id", async (c) => {
    const row = await (c.env as Env).DB.prepare("SELECT json FROM runs WHERE id = ?")
      .bind(c.req.param("id"))
      .first<{ json: string }>();
    if (!row) return c.json({ error: "not found" }, 404);
    const r = JSON.parse(row.json) as SerializedRun;
    return c.json({
      runId: r.runId,
      status: r.status,
      error: r.error,
      nodes: Object.fromEntries(r.nodes),
    });
  });

  // Content-addressed assets from R2.
  app.get("/api/assets/:hash", (c) => serveAsset(c, rt, false));
  // Thumbnails: no server-side transcoding on Workers — serve the full asset
  // (the client renders it the same; R2 egress is free).
  app.get("/api/thumbs/:hash", (c) => serveAsset(c, rt, true));

  // Live progress feed — forward the WebSocket upgrade to the Feed DO.
  app.get("/ws", (c) => feed().fetch(c.req.raw));

  return app;
}

async function serveAsset(
  c: Context,
  rt: Runtime,
  thumb: boolean,
): Promise<Response> {
  const hash = c.req.param("hash");
  if (!hash) return c.json({ error: "missing hash" }, 400);
  try {
    // `thumb` requests fall back to the full asset bytes: there is no
    // server-side thumbnail generation on Workers (no sharp), and R2 egress
    // is free, so serving the original is the correct free-tier trade.
    const meta = await rt.assets.getMeta(hash);
    const bytes = await rt.assets.get(hash);
    return new Response(bytes, {
      headers: { "Content-Type": meta.mime, "Cache-Control": IMMUTABLE },
    });
  } catch {
    return c.json({ error: "not found" }, 404);
  }
}

/** The isolate-singleton app (bindings are stable within a deployment). */
let app: Hono | undefined;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // Everything that isn't API or the WS feed is the built web app.
    if (!url.pathname.startsWith("/api") && url.pathname !== "/ws") {
      return env.STATIC.fetch(request);
    }
    app ??= createApp(env);
    return app.fetch(request, env);
  },
};
