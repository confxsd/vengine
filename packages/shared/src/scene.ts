import { z } from "zod";

/**
 * **Scene understanding** — the image→text half of the studio. The engine already
 * goes text/refs → image; a `SceneReference` captures the reverse: a sample scene
 * image is read by a vision model into a structured, *editable* `SceneBreakdown`,
 * saved durably, and later replayed as a prompt seed so the same composition can be
 * regenerated in the author's own style with their own cast.
 *
 * Stored inside the same `library.json` document as characters/styles (the image
 * bytes stay in the content-addressed asset store; only the `sourceHash` is kept).
 */

/** ISO-8601 timestamps; the server stamps these (clients never author time). */
const isoString = z.string();

/** Lifecycle of a scene's description job. */
export const SceneStatus = {
  Describing: "describing",
  Ready: "ready",
  Failed: "failed",
} as const;
export type SceneStatus = (typeof SceneStatus)[keyof typeof SceneStatus];
const SCENE_STATUS_VALUES = Object.values(SceneStatus) as [SceneStatus, ...SceneStatus[]];

/**
 * A vision model's structured read of a scene. Each field is one orthogonal facet
 * so the author can keep `composition` while swapping `styleNotes`, or feed only
 * `caption` to a frame. All fields default to empty: a model that omits one (or a
 * user who clears it) still yields a valid breakdown.
 */
export const SceneBreakdownSchema = z.object({
  /** One prompt-ready paragraph: the whole scene as a single vivid description. */
  caption: z.string().default(""),
  /** The subjects/characters present (e.g. "a rabbit in robes", "an old sage"). */
  subjects: z.array(z.string()).default([]),
  /** Where it happens — place, era, environment. */
  setting: z.string().default(""),
  /** Framing, camera, arrangement of elements. */
  composition: z.string().default(""),
  /** Light quality, direction, time of day. */
  lighting: z.string().default(""),
  /** Dominant colors — hex (e.g. "#1b2a4a") or names. */
  palette: z.array(z.string()).default([]),
  /** Emotional tone / atmosphere. */
  mood: z.string().default(""),
  /** Medium / rendering cues the model observed (kept separate so they can be dropped
   *  in favor of the author's own style). */
  styleNotes: z.string().default(""),
});
export type SceneBreakdown = z.infer<typeof SceneBreakdownSchema>;

/** A saved scene reference: the source image + its (editable) description + status. */
export const SceneReferenceSchema = z.object({
  id: z.string().min(1),
  name: z.string().default(""),
  /** Content-addressed hash of the uploaded source image. */
  sourceHash: z.string().length(64),
  status: z.enum(SCENE_STATUS_VALUES).default(SceneStatus.Describing),
  /** Present once described; absent while describing or if it failed. */
  description: SceneBreakdownSchema.optional(),
  tags: z.array(z.string()).default([]),
  /** Failure reason when status is "failed". */
  error: z.string().optional(),
  createdAt: isoString.optional(),
  updatedAt: isoString.optional(),
});
export type SceneReference = z.infer<typeof SceneReferenceSchema>;

/**
 * A **series**: a durable grouping of projects that share a cast and a default
 * style, giving long-form work continuity across many chapters. Projects, cast and
 * style are referenced by id (no copies), so editing the source updates the series.
 */
export const SeriesSchema = z.object({
  id: z.string().min(1),
  name: z.string().default(""),
  description: z.string().default(""),
  /** Comic project ids that belong to this series. */
  projectIds: z.array(z.string()).default([]),
  /** Library character ids that recur across the series. */
  castIds: z.array(z.string()).default([]),
  /** Library style-pack id applied by default to the series' projects. */
  defaultStyleId: z.string().optional(),
  createdAt: isoString.optional(),
  updatedAt: isoString.optional(),
});
export type Series = z.infer<typeof SeriesSchema>;
