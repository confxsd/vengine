import { randomUUID } from "node:crypto";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import type { WSContext } from "hono/ws";
import { z } from "zod";
import { GraphDocumentSchema, type NodeProgressEvent } from "@vengine/shared";
import { createRuntime, modelManifest, nodeManifest } from "./runtime.js";
import { registerComicRoutes } from "./comics.js";
import { registerAssistRoutes } from "./assist.js";

// Load secrets from a .env file (server cwd, then up to the repo root) into
// process.env before anything reads a key. Real env vars always take precedence.
for (const candidate of [".env", "../.env", "../../.env"]) {
  try {
    process.loadEnvFile(candidate);
    break;
  } catch {
    /* no file here — try the next location */
  }
}

const PORT = Number(process.env.PORT ?? 5174);
const rt = createRuntime();

const app = new Hono();
app.use("/api/*", cors());

const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
const clients = new Set<WSContext>();

function broadcast(event: NodeProgressEvent & { kind?: string }): void {
  const msg = JSON.stringify(event);
  for (const ws of clients) {
    try {
      ws.send(msg);
    } catch {
      clients.delete(ws);
    }
  }
}

app.get("/", (c) =>
  c.json({
    name: "vengine server",
    ok: true,
    endpoints: ["/api/health", "/api/models", "/api/nodes", "/api/plan", "/api/run", "/api/assist", "/ws"],
  }),
);
app.get("/api/health", (c) => c.json({ ok: true }));
app.get("/api/models", (c) => c.json(modelManifest(rt.providers)));
app.get("/api/nodes", (c) => c.json(nodeManifest(rt.registry)));

// Comic Studio: project CRUD, snapshots, compile-and-run, asset upload.
registerComicRoutes(app, rt, broadcast);

// AI text assist: optimize/enrich/fix prompts and prose fields.
registerAssistRoutes(app, rt);

const RunBody = z.object({
  graph: GraphDocumentSchema,
  quality: z.enum(["preview", "final"]).optional(),
  targets: z.array(z.string()).optional(),
});

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

app.post("/api/run", async (c) => {
  const parsed = RunBody.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.message }, 400);

  const runId = randomUUID();
  broadcast({ runId, nodeId: "*", status: "running", at: new Date().toISOString() });

  const result = await rt.executor.run(parsed.data.graph, {
    runId,
    services: rt.services,
    quality: parsed.data.quality,
    targets: parsed.data.targets,
    emit: (e) => broadcast(e),
  });

  // Serialize the Map of node results for JSON transport.
  const nodes = Object.fromEntries(result.nodes);
  return c.json({ runId: result.runId, status: result.status, error: result.error, nodes });
});

const IMMUTABLE = "public, max-age=31536000, immutable";

async function serveAsset(c: Context, thumb: boolean) {
  const hash = c.req.param("hash");
  if (!hash) return c.json({ error: "missing hash" }, 400);
  try {
    if (thumb) {
      const { readFile } = await import("node:fs/promises");
      const buf = await readFile(rt.assets.thumbPath(hash));
      return new Response(new Uint8Array(buf), {
        headers: { "Content-Type": "image/webp", "Cache-Control": IMMUTABLE },
      });
    }
    const meta = await rt.assets.getMeta(hash);
    const buf = await rt.assets.get(hash);
    return new Response(new Uint8Array(buf), {
      headers: { "Content-Type": meta.mime, "Cache-Control": IMMUTABLE },
    });
  } catch {
    return c.json({ error: "not found" }, 404);
  }
}

app.get("/api/assets/:hash", (c) => serveAsset(c, false));
app.get("/api/thumbs/:hash", (c) => serveAsset(c, true));

app.get(
  "/ws",
  upgradeWebSocket(() => ({
    onOpen: (_e, ws) => clients.add(ws),
    onClose: (_e, ws) => clients.delete(ws),
    onError: (_e, ws) => clients.delete(ws),
  })),
);

const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`✓ vengine server ready on http://localhost:${info.port}`);
});
injectWebSocket(server);
