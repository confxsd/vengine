import type { Hono } from "hono";
import {
  LibraryCharacterSchema,
  StylePackSchema,
  LoraKind,
  type TrainingProgressEvent,
} from "@vengine/shared";
import { analyzeSheet, cropRegion, cropPreview } from "@vengine/providers";
import { z } from "zod";
import type { Runtime } from "./runtime.js";
import { TrainingService } from "./training.js";

/** A crop rectangle in full-resolution sheet pixels (mirrors providers' `Box`). */
const SheetBoxSchema = z.object({
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
  w: z.number().int().positive(),
  h: z.number().int().positive(),
});
const SegmentBody = z.object({ hash: z.string().length(64) });
const ExtractBody = z.object({
  hash: z.string().length(64),
  characterId: z.string().min(1),
  boxes: z.array(SheetBoxSchema).min(1).max(48),
});

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

  // --- Character-sheet ingestion -----------------------------------------
  // Split one combined reference sheet into clean per-pose identity refs. Two phases so
  // the human reviews before anything is stored: (1) `segment` proposes crop regions
  // with inline previews; (2) `extract` crops the boxes the user kept, banks them in the
  // asset store, and appends them to the character's references.
  app.post("/api/library/sheet/segment", async (c) => {
    const parsed = SegmentBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await rt.assets.get(parsed.data.hash));
    } catch {
      return c.json({ error: "sheet asset not found" }, 404);
    }
    const { width, height, regions } = await analyzeSheet(bytes);
    const out = await Promise.all(
      regions.map(async (r) => ({
        box: r.box,
        suggested: r.suggested,
        preview: await cropPreview(bytes, r.box),
      })),
    );
    return c.json({ width, height, regions: out });
  });

  app.post("/api/library/sheet/extract", async (c) => {
    const parsed = ExtractBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const { hash, characterId, boxes } = parsed.data;
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await rt.assets.get(hash));
    } catch {
      return c.json({ error: "sheet asset not found" }, 404);
    }
    const added: string[] = [];
    for (const box of boxes) {
      try {
        const crop = await cropRegion(bytes, box);
        const ref = await rt.assets.put(crop, "image/jpeg");
        added.push(ref.hash);
      } catch {
        /* a box outside the image (stale client state) — skip it */
      }
    }
    if (added.length === 0) return c.json({ error: "no valid crops produced" }, 400);
    const character = await rt.library.appendCharacterRefs(characterId, added);
    if (!character) return c.json({ error: "character not found" }, 404);
    return c.json({ character, added });
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
