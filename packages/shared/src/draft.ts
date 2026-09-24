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
  /**
   * The storyline this beat belongs to — a short stable label ("joker's tale",
   * "the fortune teller memory"). Empty = the main storyline. A story that contains
   * a story (a narrator + the tale they tell), a flashback or a cutaway weaves
   * several storylines, and they can interleave (frames 1 & 4 one, 2 & 3 another);
   * the label groups them so each can keep its own look (contrast between
   * storylines, consistency within one). Default "" so a single-storyline parse
   * (or a model that omits it) is always valid.
   */
  thread: z.string().default(""),
  /**
   * This beat's emotional tone, derived from its subtext — set when the beat
   * breaks from the story's prevailing mood (which lands in `storyMood`), or to
   * separate interleaved storylines tonally. Default "" (inherit the story mood).
   */
  mood: z.string().default(""),
  /**
   * Color accents (hex or names) for this beat — the visual-contrast lever for
   * interleaved storylines (one palette per thread). Empty when the draft has a
   * single storyline or no meaningful color split.
   */
  palette: z.array(z.string()).default([]),
  /**
   * 0-based index of an EARLIER parsed frame this beat literally continues (same
   * scene, moments later) — including a NON-ADJACENT frame of an interleaved
   * storyline (frame 4 continuing frame 1). Absent = the beat starts its own scene.
   * Applied as the frame's `continuesFrameId` (scene-continuity reference).
   */
  continues: z.number().int().nonnegative().optional(),
});
export type DraftFrame = z.infer<typeof DraftFrameSchema>;

/** A text model's structured read of a whole draft. All fields default so a model
 *  that omits one (or returns a partial object) still yields a valid parse. */
export const DraftParseSchema = z.object({
  /** A short title inferred from the draft, if any. */
  title: z.string().default(""),
  /** The overall narrative arc as prose (drops straight into the project `story`). */
  story: z.string().default(""),
  /** The story's prevailing emotional tone, derived from its theme (project `storyMood`). */
  storyMood: z.string().default(""),
  /** The shared world/setting inferred across the draft (project `settings`). */
  settings: z.string().default(""),
  /** The beats, in reading order. */
  frames: z.array(DraftFrameSchema).default([]),
});
export type DraftParse = z.infer<typeof DraftParseSchema>;

export const DraftParseRequestSchema = z.object({
  /** The raw, free-form draft text the author pasted. */
  text: z.string().min(1).max(DRAFT_MAX_INPUT),
  /** Explicit universe (series) to parse within; omitted = auto-detect from the text. */
  seriesId: z.string().optional(),
});
export type DraftParseRequest = z.infer<typeof DraftParseRequestSchema>;

/** The universe a parse was resolved to (explicit or auto-detected). */
export interface DraftSeriesRef {
  id: string;
  name: string;
  /** Signals that matched the text (keywords / cast names) — shown so the author
   * can see *why* this universe was picked and override it if wrong. */
  matchedBy: string[];
}

export interface DraftParseResponse extends DraftParse {
  /** The model that produced the parse (for display/telemetry). */
  model: string;
  /** The universe the parse used: explicit `seriesId`, auto-detected, or null. */
  series: DraftSeriesRef | null;
}

export interface DraftConfig {
  /** True when a text model is registered AND its API key is set server-side. */
  available: boolean;
  /** Display name of the active model, or null when unavailable. */
  model: string | null;
}
