import type { Hono } from "hono";
import {
  LibraryCharacterSchema,
  StylePackSchema,
  LoraKind,
  type TrainingProgressEvent,
} from "@vengine/shared";
import { z } from "zod";
import type { Runtime } from "./runtime.js";
import { TrainingService } from "./training.js";

/** Request to start a training job. The dataset is referenced by asset hash, so the
 *  client never re-uploads images already in the store (e.g. a character's refs). */
const TrainBody = z.object({
  trainerId: z.string().default("fal/flux-2-trainer"),
  name: z.string().default(""),
  kind: z.enum([LoraKind.Subject, LoraKind.Style]).default(LoraKind.Subject),
  refHashes: z.array(z.string().length(64)).min(1),
  captions: z.array(z.string()).optional(),
  triggerWord: z.string().optional(),
  defaultCaption: z.string().optional(),
  isStyle: z.boolean().optional(),
  steps: z.number().int().positive().optional(),
  characterId: z.string().optional(),
});

/** Lightweight trainer manifest for the client's "train" UI — includes `pricePerStep`
 *  so the client shows an accurate cost estimate from one source of truth. */
export function trainerManifest(rt: Runtime) {
  return rt.trainers.list().map((t) => ({
    id: t.id,
    displayName: t.displayName,
    baseModelId: t.baseModelId,
    trains: t.trains,
    pricePerStep: t.pricePerStep,
  }));
}

/**
 * Mount the cross-project Library routes: characters / style packs CRUD, and the
 * **durable** training endpoints. The persisted library is the source of truth; WS
 * `training` events are best-effort hints, so a client that missed events just
 * `GET /api/library` on reconnect.
 */
export function registerLibraryRoutes(
  app: Hono,
  rt: Runtime,
  broadcast: (event: TrainingProgressEvent) => void,
): TrainingService {
  const training = new TrainingService({
    library: rt.library,
    assets: rt.assets,
    trainers: rt.trainers,
    getApiKey: () => rt.services.getApiKey?.("fal"),
    broadcast,
  });

  // Whole library (source of truth; the client refetches this on reconnect).
  app.get("/api/library", async (c) => c.json(await rt.library.get()));
  app.get("/api/trainers", (c) => c.json(trainerManifest(rt)));

  // --- Characters ---------------------------------------------------------
  app.put("/api/library/characters", async (c) => {
    const parsed = LibraryCharacterSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    return c.json(await rt.library.upsertCharacter(parsed.data));
  });
  app.delete("/api/library/characters/:id", async (c) => {
    await rt.library.removeCharacter(c.req.param("id"));
    return c.json({ ok: true });
  });

  // --- Style packs --------------------------------------------------------
  app.put("/api/library/styles", async (c) => {
    const parsed = StylePackSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    return c.json(await rt.library.upsertStyle(parsed.data));
  });
  app.delete("/api/library/styles/:id", async (c) => {
    await rt.library.removeStyle(c.req.param("id"));
    return c.json({ ok: true });
  });

  // --- Training (durable) -------------------------------------------------
  // Returns immediately with the persisted record (status "training"); the job runs
  // server-side and streams progress over WS. The client tracks the record, not the
  // request, so a disconnect mid-train is harmless.
  app.post("/api/training", async (c) => {
    const parsed = TrainBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const params = { ...parsed.data };
    // For a character train with no explicit caption, derive one from the character's
    // own description (a far better concept anchor than a bare token — and never the
    // photorealism-biasing "a photo of …"). Style trains keep auto/empty captioning.
    if (params.kind === LoraKind.Subject && !params.defaultCaption && params.characterId) {
      const ch = (await rt.library.get()).characters.find((x) => x.id === params.characterId);
      const desc = ch?.description?.trim();
      const trigger = params.triggerWord?.trim() || ch?.name?.trim();
      if (desc) params.defaultCaption = trigger ? `${trigger}, ${desc}` : desc;
    }
    try {
      const record = await training.start(params);
      return c.json(record);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });
  app.delete("/api/library/loras/:id", async (c) => {
    await training.remove(c.req.param("id"));
    return c.json({ ok: true });
  });

  return training;
}
