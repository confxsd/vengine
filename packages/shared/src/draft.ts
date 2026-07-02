import { z } from "zod";

/**
 * **Draft import** — the front door for authors who write their story as free prose
 * (frame markers, `(parenthetical)` scene directions, dialogue and inner-voice) and
 * don't want to hand-split it into frames. A text model reads the whole draft into a
 * structured, *reviewable* `DraftParse`: an overall story/settings plus one
 * `DraftFrame` per beat, each carrying a prompt-ready VISUAL description of the single
 * drawing and the beat's script kept as author metadata.
 *
 * Comics here render **no text in the image**, so the parser's job is to translate what
 * characters say/feel into what is *visible* — expression, posture, gesture, staging —
 * and put that in `prompt`, while the literal lines are preserved untouched in `script`.
 *
 * The seeded system prompt that drives the model lives server-side in
 * `apps/server/src/draft.ts`; this module is the shared contract (schemas both sides
 * validate against), mirroring `assist.ts` and `scene.ts`.
 */

/** Max characters of draft accepted in one parse (guards token cost / abuse). */
export const DRAFT_MAX_INPUT = 20_000;

/**
 * One parsed beat of the draft. `prompt` is the visual description an image model can
 * use as-is (no on-image text, no speech bubbles); `script` is the beat's original
 * dialogue/narration, kept verbatim-ish for the author (never rendered). `characters`
 * are the names visibly present, used to map onto existing cast on apply.
 */
export const DraftFrameSchema = z.object({
  /** Prompt-ready visual description of this single 9:16 drawing. */
  prompt: z.string().default(""),
  /** The beat's dialogue / inner-voice / narration, preserved as author metadata. */
  script: z.string().default(""),
  /** Names of characters visibly present in this frame (best-effort). */
  characters: z.array(z.string()).default([]),
});
export type DraftFrame = z.infer<typeof DraftFrameSchema>;

/** A text model's structured read of a whole draft. All fields default so a model
 *  that omits one (or returns a partial object) still yields a valid parse. */
export const DraftParseSchema = z.object({
  /** A short title inferred from the draft, if any. */
  title: z.string().default(""),
  /** The overall narrative arc as prose (drops straight into the project `story`). */
  story: z.string().default(""),
  /** The shared world/setting inferred across the draft (project `settings`). */
  settings: z.string().default(""),
  /** The beats, in reading order. */
  frames: z.array(DraftFrameSchema).default([]),
});
export type DraftParse = z.infer<typeof DraftParseSchema>;

export const DraftParseRequestSchema = z.object({
  /** The raw, free-form draft text the author pasted. */
  text: z.string().min(1).max(DRAFT_MAX_INPUT),
});
export type DraftParseRequest = z.infer<typeof DraftParseRequestSchema>;

export interface DraftParseResponse extends DraftParse {
  /** The model that produced the parse (for display/telemetry). */
  model: string;
}

export interface DraftConfig {
  /** True when a text model is registered AND its API key is set server-side. */
  available: boolean;
  /** Display name of the active model, or null when unavailable. */
  model: string | null;
}
