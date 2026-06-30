import type { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  SceneBreakdownSchema,
  SceneStatus,
  type SceneBreakdown,
  type SceneReference,
} from "@vengine/shared";
import type { VisionAdapter } from "@vengine/providers";
import type { Runtime } from "./runtime.js";

/**
 * Scene-understanding routes. A sample scene image is read by a vision model into a
 * structured, editable `SceneBreakdown`, then saved as a `SceneReference` in the
 * library. All prompt-craft lives in the config below (system + the field schema we
 * ask the model to fill), so tuning the extraction is data, not control flow —
 * mirroring the assist routes.
 *
 * The fal queue resolves in seconds, so describe runs **inline**: the record is
 * persisted as `describing`, the model is called, and the record is patched to
 * `ready` (with the breakdown) or `failed` (with the reason) before responding — a
 * single request the client can show a spinner over, with a durable record either way.
 */

/** Preferred vision model; falls back to whatever is registered first. */
const DEFAULT_VISION_MODEL = "fal/vision";

/** Output rules + the exact JSON shape we want back. Keep in lockstep with `SceneBreakdown`. */
const SYSTEM_PROMPT = `You are a precise visual analyst for an art studio. You look at one reference image and describe it as structured data an artist can reuse to recompose the same scene in a different art style.

Return ONLY a single JSON object — no markdown, no code fences, no commentary. Use exactly these keys:
{
  "caption": string,        // one vivid prompt-ready paragraph describing the whole scene
  "subjects": string[],     // the main subjects/characters, each a short phrase
  "setting": string,        // place, era, environment
  "composition": string,    // framing, camera angle, arrangement of elements
  "lighting": string,       // light quality, direction, time of day
  "palette": string[],      // 3-6 dominant colors as hex (e.g. "#1b2a4a") where possible
  "mood": string,           // emotional tone / atmosphere
  "styleNotes": string      // the medium/rendering you observe (this may be replaced by the artist's own style)
}

Be concrete and faithful to what is visible. Do not invent text, signage, or brand names. If a field is not determinable, use an empty string or empty array.`;

const USER_INSTRUCTION =
  "Describe this reference image as the JSON object specified. Output JSON only.";

const DescribeBody = z.object({
  hash: z.string().length(64),
  name: z.string().optional(),
});

/** Patch the editable parts of a saved scene. */
const PatchBody = z.object({
  name: z.string().optional(),
  tags: z.array(z.string()).optional(),
  description: SceneBreakdownSchema.partial().optional(),
});

/**
 * Pull a `SceneBreakdown` out of a model reply that is *supposed* to be JSON but may
 * arrive fenced or with stray prose. Strip code fences, isolate the first balanced
 * `{...}`, parse leniently (schema defaults fill any missing field). On total
 * failure, degrade gracefully: keep the raw text as the caption so nothing is lost.
 */
export function parseBreakdown(raw: string): SceneBreakdown {
  const cleaned = raw.replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const parsed = SceneBreakdownSchema.safeParse(JSON.parse(cleaned.slice(start, end + 1)));
      if (parsed.success) return parsed.data;
    } catch {
      /* fall through to the raw-caption fallback */
    }
  }
  return SceneBreakdownSchema.parse({ caption: cleaned });
}

export function registerSceneRoutes(app: Hono, rt: Runtime): void {
  const resolveModel = (): VisionAdapter | undefined =>
    rt.visionProviders.get(DEFAULT_VISION_MODEL) ?? rt.visionProviders.list()[0];

  // Availability probe so the client only offers scene description when usable.
  app.get("/api/scenes/config", (c) => {
    const model = resolveModel();
    const apiKey = model ? rt.services.getApiKey?.(model.provider) : undefined;
    return c.json({ available: !!(model && apiKey), model: model?.displayName ?? null });
  });

  // Describe a scene image → persist a SceneReference (ready or failed).
  app.post("/api/scenes/describe", async (c) => {
    const parsed = DescribeBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const { hash, name } = parsed.data;

    const model = resolveModel();
    if (!model) return c.json({ error: "No vision model is registered." }, 503);
    const apiKey = rt.services.getApiKey?.(model.provider);
    if (!apiKey) {
      return c.json(
        { error: `Set ${model.provider.toUpperCase()}_KEY in the server env to describe scenes.` },
        503,
      );
    }

    // Confirm the source image exists before creating a record.
    let bytes: Uint8Array;
    let mime: string;
    try {
      bytes = new Uint8Array(await rt.assets.get(hash));
      mime = (await rt.assets.getMeta(hash)).mime;
    } catch {
      return c.json({ error: "scene image not found" }, 404);
    }

    // Persist a "describing" record first so a failure still leaves something durable
    // (the user can see it failed, retry, or delete it) rather than vanishing.
    const draft: SceneReference = {
      id: randomUUID().slice(0, 8),
      name: name?.trim() || "Untitled scene",
      sourceHash: hash,
      status: SceneStatus.Describing,
      tags: [],
    };
    let scene = await rt.library.upsertScene(draft);

    try {
      const result = await model.describe(
        { image: { bytes, mime }, prompt: USER_INSTRUCTION, system: SYSTEM_PROMPT },
        { apiKey },
      );
      const description = parseBreakdown(result.text);
      scene =
        (await rt.library.patchScene(scene.id, {
          status: SceneStatus.Ready,
          description,
          error: undefined,
        })) ?? scene;
      return c.json(scene);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      scene = (await rt.library.patchScene(scene.id, { status: SceneStatus.Failed, error: message })) ?? scene;
      return c.json({ ...scene, error: message }, 502);
    }
  });

  // Edit the saved breakdown / name / tags (a merge over the current description).
  app.put("/api/scenes/:id", async (c) => {
    const parsed = PatchBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const id = c.req.param("id");

    const current = (await rt.library.get()).scenes.find((s) => s.id === id);
    if (!current) return c.json({ error: "scene not found" }, 404);

    const patch: Partial<SceneReference> = {};
    if (parsed.data.name !== undefined) patch.name = parsed.data.name;
    if (parsed.data.tags !== undefined) patch.tags = parsed.data.tags;
    if (parsed.data.description !== undefined) {
      // Merge edits over the existing breakdown so a single-field edit is enough.
      patch.description = SceneBreakdownSchema.parse({
        ...(current.description ?? {}),
        ...parsed.data.description,
      });
    }
    const saved = await rt.library.patchScene(id, patch);
    if (!saved) return c.json({ error: "scene not found" }, 404);
    return c.json(saved);
  });

  app.delete("/api/scenes/:id", async (c) => {
    await rt.library.removeScene(c.req.param("id"));
    return c.json({ ok: true });
  });
}
