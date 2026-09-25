import { z } from "zod";
import { GraphDocumentSchema, type GraphDocument } from "./graph.js";
import { DirectorMessageSchema } from "./director.js";
import {
  EpisodePlanSchema,
  FRAME_ROLES,
  GUTTER_TYPES,
  type EpisodePlan,
  type FrameRole,
  type GutterType,
} from "./episode.js";

// The episode-planning vocabulary (structures/roles/gutters + the plan schema)
// lives in the leaf module `episode.ts` and is re-exported here so the comic
// layer stays its public home — while `director.ts` can build on the same data
// without a comic ⇄ director import cycle (this file imports director's schema).
export * from "./episode.js";

/**
 * A comic project is the user-facing document for the Comic Studio: a main story
 * + settings, one broad visual style, and an ordered list of frames each with
 * its own prompt. It is NOT executed directly — `compileComic` lowers it to a
 * plain `GraphDocument` that the existing engine runs, so the comic layer adds
 * zero coupling to the executor.
 *
 * Persisted as JSON (see @vengine/storage ProjectStore). `resultHash` on a frame
 * is the last generated image's asset hash and is server-authoritative.
 */

/** Built-in negative prompt: these comics are single drawings with no text/marks. */
export const DEFAULT_NEGATIVE =
  "text, words, letters, typography, watermark, signature, speech bubble, caption, logo, frame border, panel grid";

/**
 * Default prompt template. Tokens are substituted by `composeFramePrompt`:
 *   {story}    — the project's overall narrative (opt-in; omitted by default)
 *   {settings} — world/setting details shared by every frame
 *   {style}    — the broad visual style theme
 *   {frame}    — this frame's specific prompt
 * The frame prompt leads (subject first), with setting + style as trailing context.
 */
export const DEFAULT_TEMPLATE = "{frame}\n\nSetting: {settings}\nStyle: {style}";

/**
 * True 9:16 vertical default (768×1344 = 0.571, multiples of 16 → SDXL/fal-friendly).
 * The whole feature is premised on vertical single drawings, so the default must
 * actually be 9:16, not merely portrait.
 */
export const DEFAULT_WIDTH = 768;
export const DEFAULT_HEIGHT = 1344;

/** Cap on retained variants per frame — enough to compare iterations, bounded so
 *  a long exploration session doesn't grow the project document unboundedly. */
export const MAX_VARIANTS = 16;

// ---------------------------------------------------------------------------
// Episode planning — the episode as a *directed* strip (see docs/EPISODE_STUDIO.md).
// The vocabulary/schema live in episode.ts (re-exported above); the machinery
// that USES them — role flavors, transition/echo directives, reconciliation,
// rhythm review — stays here with the rest of prompt composition.
// ---------------------------------------------------------------------------

/** Reader-effort score per gutter (McCloud/Cohn): smaller = easier to bridge.
 *  A 4-strip summing over 12 is flagged by `rhythmWarnings` as hard reading. */
export const GUTTER_EFFORT: Record<GutterType, number> = {
  moment: 1,
  action: 2,
  subject: 3,
  aspect: 4,
  scene: 5,
  nonsequitur: 6,
};

/** The advisory ceiling on a strip's total gutter effort (see `GUTTER_EFFORT`). */
export const GUTTER_EFFORT_MAX = 12;

/** One generated iteration of a frame: the image hash plus the seed that made it
 *  (so re-selecting a variant is reproducible). */
export const ComicVariantSchema = z.object({
  hash: z.string().length(64),
  seed: z.number().int(),
});
export type ComicVariant = z.infer<typeof ComicVariantSchema>;

/**
 * A recurring character in the comic. Its `refHashes` are identity-establishing
 * images (an uploaded portrait, or a generated "character sheet" frame's output)
 * fed as references to every frame the character appears in — the lever for
 * character consistency, distinct from the project-wide style anchor.
 */
export const ComicCharacterSchema = z.object({
  /** Stable id frames reference via `frame.characterIds`. */
  id: z.string().min(1),
  name: z.string().default(""),
  /** Alternate names this cast member answers to ("bruce", "batman" → Bruce Wayne);
   * draft parsing maps parsed character names onto the cast via name OR alias. */
  aliases: z.array(z.string()).default([]),
  /** Identity reference image hashes (most-distinctive first; models weight earlier
   *  refs higher). Only the first `MAX_REFS_PER_CHARACTER` are fed to any one frame so
   *  a big auto-split sheet can't monopolise the model's reference budget. */
  refHashes: z.array(z.string().length(64)).default([]),
  /**
   * Trained **character LoRA** for this cast member — the strongest identity lock,
   * applied (on LoRA-capable models) only to frames where the character appears, so
   * it composes with the project's fixed style LoRA on the *style* axis. Copied from a
   * Library character's ready LoRA when added to the comic. Optional (refs-only is the
   * common case); kept optional so existing cast entries need no migration.
   */
  loraPath: z.string().optional(),
  loraScale: z.number().optional(),
  loraName: z.string().optional(),
  /** Origin Library character id, so the cast entry can be re-synced to the library. */
  libraryId: z.string().optional(),
  /**
   * Which named life stage ("teen", "young", "mature"…) this episode's version of
   * the character is in — see `CharacterEra` in library.ts. Informational on the
   * cast entry: when the director sets an era, the era's identity refs are copied
   * over `refHashes`, so the engine (references, LoRAs, prompts) needs no changes.
   * Optional: existing cast entries need no migration.
   */
  eraLabel: z.string().optional(),
});
export type ComicCharacter = z.infer<typeof ComicCharacterSchema>;

export const ComicFrameSchema = z.object({
  /** Stable id (never the array index): node ids + WS routing + result mapping key off this. */
  id: z.string().min(1),
  /** This frame's specific scene prompt. */
  prompt: z.string().default(""),
  /** Optional per-frame seed; falls back to the project's locked style seed. */
  seed: z.number().int().optional(),
  /**
   * Which cast members appear in this frame. Tri-state by design:
   *   undefined → the whole cast (the common case: a protagonist in every panel),
   *   []        → no characters (e.g. an establishing landscape),
   *   [ids…]    → exactly that subset.
   * Unknown ids are ignored, so removing a character never breaks a frame.
   */
  characterIds: z.array(z.string()).optional(),
  /**
   * Scene-continuity link: the id of another frame this one *continues* from. That
   * source frame's current image is fed as the strongest, leading reference, so this
   * frame stays in the same scene (setting, lighting, framing continuity) while its
   * prompt, composition, camera angle and cast move the action on. Self-links and
   * unknown ids are ignored, so reordering or removing frames never breaks a run.
   */
  continuesFrameId: z.string().optional(),
  /**
   * How the continued frame's image is used by an edit-capable model (see
   * `continuityDirective`). Two intents that an edit endpoint treats very differently:
   *   "restage" → keep the prior scene's setting/light/palette/character design, but
   *               re-compose with a NEW camera angle and blocking as the prompt asks.
   *   "shot"    → preserve the prior shot's exact composition/camera; edit in place.
   * Undefined defaults to "restage" (`DEFAULT_CONTINUES_MODE`): feeding a prior image
   * to an edit endpoint otherwise pins it pixel-for-pixel, which silently defeats any
   * "different angle" request. Inert unless `continuesFrameId` resolves to an image.
   */
  continuesMode: z.enum(["shot", "restage"]).optional(),
  /**
   * Reference images attached to THIS frame only — composition/look guidance fed when
   * the frame generates, independent of the project-wide style anchors and the shared
   * cast. Use it to steer one panel ("match this image") without touching the others.
   * Drawn from the reusable library (most-distinctive first; earlier refs weight
   * higher), applied at full weight. Unknown hashes are ignored, so removing a library
   * asset never breaks a frame.
   */
  refHashes: z.array(z.string().length(64)).default([]),
  /**
   * How this frame's identity/style references (its own `refHashes` + the project's
   * style anchors + active cast) are used by an edit-capable model — the lever that
   * stops a reference image from silently pinning the composition (see
   * `referenceDirective`):
   *   "compose" → references define character identity, wardrobe, palette and art
   *               STYLE only; the prompt fully drives camera, layout and posing
   *               (the industry-standard default — consistent look, free composition).
   *   "match"   → also reproduce the reference's composition/camera (copy a layout /
   *               pose reference). When the frame's own ref is joined by cast/style
   *               sheets, the directive names the FIRST attached image (the frame's
   *               own ref leads the order) as the composition source and the rest as
   *               identity sheets, so a pose ref steers layout without bleeding into
   *               likeness.
   * Undefined defaults to "compose" (`DEFAULT_REFERENCE_MODE`). Inert when the frame
   * feeds no identity references, and ignored when the frame is a continuation (the
   * continuity link governs composition via `continuesMode` instead).
   */
  referenceMode: z.enum(["compose", "match"]).optional(),
  /**
   * Camera / shot framing for this drawing — a short phrase (e.g. "low-angle shot
   * looking up", "extreme close-up") set from the `CAMERA_PRESETS` dropdown or typed
   * freely. Composed into the frame's prompt as a dedicated `Camera:` directive (see
   * `cameraDirective` / `composeFramePrompt`), so it steers composition without the
   * author having to hand-write shot language into every scene. Empty/undefined = the
   * prompt fully owns the camera (unchanged behaviour). Optional: existing frames need
   * no migration.
   */
  camera: z.string().optional(),
  /**
   * The author's script for this beat — its dialogue, inner-voice or narration,
   * preserved as metadata (usually captured when a free-form draft is imported; see
   * `draft.ts`). Purely a writing aid: comics render **no text in the image**, so this
   * is NEVER composed into the generation prompt — it just travels with the frame so
   * the story text isn't lost. Optional, so existing frames and the "add blank frame"
   * path need no migration.
   */
  script: z.string().optional(),
  /**
   * This frame's emotional tone — a short phrase ("wounded, withdrawing into
   * himself") composed into the prompt as a dedicated `Mood:` directive. Overrides
   * the project's `storyMood` when set, so one beat can break from the episode's
   * prevailing tone. Derived from what the characters feel/do (visible subtext),
   * not a generic label. Optional: existing frames need no migration.
   */
  mood: z.string().optional(),
  /**
   * The narrative storyline this frame belongs to — a short label ("joker's tale",
   * "the fortune teller memory"). Episodes often weave several storylines (a
   * framing story + the tale told inside it, flashbacks, cutaways), and they can
   * interleave — frames 1 & 4 one story, 2 & 3 another. The label groups frames
   * for the author and the director-chat; the visual work is done by each thread's
   * own moods/palettes (contrast BETWEEN storylines, consistency within one) and
   * `continuesFrameId` links (which may point at a non-adjacent frame of the same
   * thread). Absent = the episode's main storyline. Optional: no migration needed.
   */
  thread: z.string().optional(),
  /**
   * This frame's color accents (hex codes or color names) — the storyline-contrast
   * lever: one thread gets its own palette so it reads visually distinct from the
   * episode's other thread(s) while `style.theme` keeps the art style shared.
   * Composed by `composeFramePrompt` INSTEAD of the project-wide `style.palette`
   * when present: undefined inherits the project's, an explicit empty array drops
   * the palette lock for this frame (same override shape as `mood` vs `storyMood`).
   * Optional: existing frames need no migration.
   */
  palette: z.array(z.string()).optional(),
  /**
   * This panel's role in the episode structure (`establish | develop | escalate |
   * turn | settle | payoff`) — defaults from the plan's slot map at draft-apply
   * time. Parameterizes the craft directive (see `craftDirective`): the turn
   * takes the episode's biggest camera change, the settle re-stabilizes, the
   * payoff detonates. Roles are labels with teeth — composition, not metadata.
   * Optional: existing frames need no migration (no role → house craft only).
   */
  role: z.enum(FRAME_ROLES).optional(),
  /**
   * The typed gutter between the previous panel and this one (McCloud's six:
   * `moment | action | subject | scene | aspect | nonsequitur`), set on frame
   * i ≥ 1 only — it describes the transition INTO this panel and composes into
   * the prompt as a `Transition:` directive (see `transitionDirective`). The
   * reconciliation rule (`gutterReconcile`) keeps it from ever contradicting
   * `continuesFrameId`: moment/action/subject auto-link to the predecessor,
   * scene/aspect/nonsequitur clear an adjacent link. Optional: no migration.
   */
  gutter: z.enum(GUTTER_TYPES).optional(),
  /**
   * Strictly-earlier frame whose composition this panel mirrors — the bookend
   * payout (P4 mirrors P1 with exactly one thing different). The echo source's
   * current image is fed as the LEADING reference and the echo directive
   * governs composition (it overrides the plain reference directive and wins
   * over a continuity link; `rhythmWarnings` flags the both-set case). Validated
   * like `continuesFrameId`: self-links and unknown ids are ignored, so edits
   * never break a run. Optional: existing frames need no migration.
   */
  echoFrameId: z.string().optional(),
  /** The currently selected/displayed image (a hash from `variants`). The artist
   *  picks it; a run sets it to the freshest generation. */
  resultHash: z.string().length(64).optional(),
  /** Generation history (most-recent last). Server-authoritative: the store
   *  union-merges this, so a stale client save can never drop an iteration. */
  variants: z.array(ComicVariantSchema).default([]),
});
export type ComicFrame = z.infer<typeof ComicFrameSchema>;

/**
 * Merge a freshly generated variant into a frame's history: dedup by hash
 * (content-addressed, so identical bytes never duplicate), keep most-recent-last,
 * and cap the list. Used by the store on every successful generation.
 */
export function unionVariants(
  existing: readonly ComicVariant[] | undefined,
  incoming: readonly ComicVariant[] | undefined,
): ComicVariant[] {
  const byHash = new Map<string, ComicVariant>();
  for (const v of existing ?? []) byHash.set(v.hash, v);
  for (const v of incoming ?? []) byHash.set(v.hash, v); // incoming wins (freshest seed)
  const merged = [...byHash.values()];
  return merged.length > MAX_VARIANTS ? merged.slice(merged.length - MAX_VARIANTS) : merged;
}

/** Default per-reference influence weight (full strength). */
export const DEFAULT_REFERENCE_WEIGHT = 1;

/**
 * How many identity references a single character contributes to a frame. A character
 * sheet ingested via auto-split becomes many crops (`refHashes`), and feeding all of
 * them lets one character monopolise the model's reference budget — crowding out the
 * other cast and, on capped models (e.g. Nano Banana's 5), getting the *other*
 * characters' sheets truncated away. Capping at the most-distinctive few (refHashes
 * are ordered strongest-first) keeps each character's identity locked while leaving
 * room for the rest of the cast, continuity and style. */
export const MAX_REFS_PER_CHARACTER = 2;

/**
 * Move `hash` to the front of a character's `refHashes` (dedup, order preserved for
 * the rest). Earlier refs weight higher and only the first `MAX_REFS_PER_CHARACTER`
 * are ever fed to a frame, so a *deliberately promoted* image (from a frame or the
 * library) must lead — appending it would drop it past the cap where the model never
 * sees it, silently making the promote a no-op. Returns a new array.
 */
export function leadRef(refHashes: readonly string[], hash: string): string[] {
  return [hash, ...refHashes.filter((h) => h !== hash)];
}

/** Influence weight of a scene-continuity reference. Full strength by design: a
 *  continuation must lock the prior scene hard, so it leads at maximum weight. */
export const DEFAULT_CONTINUITY_WEIGHT = 1;

/** How a continuation frame uses the prior frame's image. See `ComicFrameSchema.continuesMode`. */
export type ContinuesMode = "shot" | "restage";

/** Default continuation intent when a frame sets none. "restage" (not "shot")
 *  because an edit endpoint pins a bare reference image pixel-for-pixel, so the
 *  safe default must explicitly free the camera — otherwise "new angle" requests
 *  silently produce a copy of the source frame. */
export const DEFAULT_CONTINUES_MODE: ContinuesMode = "restage";

/**
 * The continuity instruction injected into a continuation frame's prompt, telling an
 * edit-capable model HOW to treat the prior frame's image (fed as the leading
 * reference). Without this an edit endpoint defaults to "preserve the canvas and
 * inpaint", which copies the source composition and defeats a re-stage/new-angle
 * prompt. Returned as a trailing directive so the frame's own description still leads.
 *
 * When the frame ALSO carries identity/style references (cast sheets, style anchors,
 * per-frame refs), pass `hasIdentityRefs` so the directive (a) names those extra
 * images as the canonical character/style sheets and (b) stops sourcing character
 * likeness from the previous panel — otherwise the model anchors identity to however
 * a character happened to be posed/occluded in the prior frame instead of its clean
 * sheet, so the same character drifts between a non-continuation frame and a
 * continuation of it. The no-identity wording is preserved verbatim.
 */
export function continuityDirective(mode: ContinuesMode, hasIdentityRefs = false): string {
  if (mode === "shot") {
    const lead = hasIdentityRefs ? "the FIRST attached image" : "the reference image";
    const base = `Continuity: ${lead} is THIS exact shot — preserve its composition, camera angle and framing, and change only what the description above specifies.`;
    return hasIdentityRefs
      ? `${base} The remaining attached images are the character and style reference sheets: keep every character consistent with their own sheet.`
      : base;
  }
  return hasIdentityRefs
    ? "Continuity: the FIRST attached image is the previous panel of this same scene. Treat it ONLY as a reference for setting, lighting, color palette and wardrobe continuity — NOT as a layout to keep, and NOT as the source of any character's likeness. The remaining attached images are the character and style reference sheets: take each character's identity — face, body, proportions, fur and markings, wardrobe — from their own sheet, matching every character to it rather than to how they happened to appear in the previous panel. Build an entirely NEW composition with its own camera angle, framing and blocking exactly as described above. The new panel may contain different, additional or fewer characters than the previous panel: introduce and arrange every character the description names, each as their own distinct figure. Do NOT simply repaint, recolor or swap the existing figure, do not drop a newly described character, and do not copy the previous panel's framing, camera or poses."
    : "Continuity: the reference image is the previous panel of this same scene. Treat it ONLY as a reference for setting, lighting, color palette, character design and wardrobe — NOT as a layout to keep. Build an entirely NEW composition with its own camera angle, framing and blocking exactly as described above. The new panel may contain different, additional or fewer characters than the reference: introduce and arrange every character the description names, each as their own distinct figure. Do NOT simply repaint, recolor or swap the existing figure, do not drop a newly described character, and do not copy the previous panel's framing, camera or poses.";
}

/** How a frame's identity/style references steer it. See `ComicFrameSchema.referenceMode`. */
export type ReferenceMode = "compose" | "match";

/** Default reference intent: `"compose"` — references lock identity & style, the prompt
 *  owns composition. The industry-standard expectation (character LoRA / IP-Adapter /
 *  `--cref`): feeding a reference must NOT silently copy its layout. */
export const DEFAULT_REFERENCE_MODE: ReferenceMode = "compose";

/**
 * The directive injected into a frame's prompt telling an edit-capable model HOW to
 * use its identity/style reference images (cast portraits, style anchors, per-frame
 * refs). Without it, an edit endpoint treats any supplied image as a canvas to
 * reproduce — so a character/style reference silently pins the composition and the
 * prompt can't move the camera or restage the shot (the root cause of "it just keeps
 * generating the same image"). Returned as a trailing directive so the frame's own
 * description still leads.
 */
export function referenceDirective(mode: ReferenceMode, hasIdentitySheets = false): string {
  if (mode !== "match") {
    return "Reference images: use the attached images for CHARACTER IDENTITY (faces, bodies, wardrobe), COLOR PALETTE and ART STYLE only. Do NOT copy their composition, camera angle, cropping, poses or layout — build an entirely new image with the composition, camera, staging and posing described above.";
  }
  // With cast/style sheets alongside the frame's own layout ref, the model must know
  // WHICH image carries the composition — otherwise it may match a character sheet's
  // layout, or take likeness from the layout ref. Frame-own refs lead the reference
  // order (see `identityReferences`), so "the FIRST attached image" is the layout ref.
  return hasIdentitySheets
    ? "Reference images: the FIRST attached image is the COMPOSITION reference — reproduce its composition, camera angle, framing and the pose/blocking of each figure, changing only what the description above specifies. The remaining attached images are the character and style reference sheets: take each character's identity — face, body, proportions, wardrobe — and the art style from their own sheet, NOT from the composition reference."
    : "Reference images: reproduce the composition, camera angle and layout of the reference image(s), changing only what the description above specifies.";
}

/** A frame's current still image: the selected result, else its newest variant. */
export function frameImageHash(frame: ComicFrame): string | undefined {
  return frame.resultHash ?? frame.variants.at(-1)?.hash;
}

/**
 * A reference image banked in the project's reusable library: upload (or "bank" a
 * generated frame) once, then attach the same image as a style reference and/or to
 * any number of characters without re-uploading. The library is the single pool of
 * reference material; style anchors and character casts point into it by hash.
 * `label` is a UI-only name to tell entries apart.
 */
export const ComicAssetSchema = z.object({
  hash: z.string().length(64),
  label: z.string().default(""),
});
export type ComicAsset = z.infer<typeof ComicAssetSchema>;

/**
 * A weighted style reference: an image hash plus how strongly it should steer the
 * look (0..1). Order also matters — models weight earlier references more — so the
 * array order is the coarse lever and `weight` the fine adjustment.
 */
export const ComicReferenceSchema = z.object({
  hash: z.string().length(64),
  weight: z.number().min(0).max(1).default(DEFAULT_REFERENCE_WEIGHT),
});
export type ComicReference = z.infer<typeof ComicReferenceSchema>;

/**
 * A trained LoRA applied to every frame on a LoRA-capable model — the strongest
 * lock for a fixed house style. `name` is a UI label only; `path`/`scale` are what
 * run. Consumed only by models that set `consumesLoras` (e.g. `fal/flux-2-lora`).
 */
export const ComicLoraSchema = z.object({
  path: z.string().default(""),
  scale: z.number().default(1),
  name: z.string().default(""),
});
export type ComicLora = z.infer<typeof ComicLoraSchema>;

export const ComicStyleSchema = z.object({
  /** Broad visual style theme applied to every frame (the consistency anchor in text form). */
  theme: z.string().default(""),
  /** Generation model id (provider registry key). */
  model: z.string().default("mock/gradient"),
  /** Locked seed shared across frames for look-consistency. */
  seed: z.number().int().default(42),
  width: z.number().int().positive().default(DEFAULT_WIDTH),
  height: z.number().int().positive().default(DEFAULT_HEIGHT),
  /**
   * Weighted style-reference images fed into every frame (look consistency).
   * Ordered (earlier = stronger) and each independently weighted, so an artist can
   * blend several look references. Superseded the single `anchorHash` below.
   */
  anchors: z.array(ComicReferenceSchema).default([]),
  /**
   * @deprecated Legacy single style anchor. Read through `styleReferences()`, which
   * migrates it into `anchors` when `anchors` is empty, so old projects keep working
   * and new writes only ever touch `anchors`.
   */
  anchorHash: z.string().length(64).optional(),
  /** Trained LoRAs applied to every frame (on LoRA-capable models). */
  loras: z.array(ComicLoraSchema).default([]),
  /**
   * Fixed color palette (hex codes like `#556B2F` or color names) composed into
   * every frame's prompt as a dedicated directive — a first-class palette lock,
   * distinct from the free-text `theme`. Empty = no palette constraint. This is the
   * structural answer to "keep the colors consistent across frames", which prose in
   * `theme` only does loosely.
   */
  palette: z.array(z.string()).default([]),
  negative: z.string().default(DEFAULT_NEGATIVE),
});
export type ComicStyle = z.infer<typeof ComicStyleSchema>;

export const ComicProjectSchema = z.object({
  version: z.literal(1).default(1),
  id: z.string().min(1),
  name: z.string().default("Untitled comic"),
  /** The overall narrative arc — context for continuity across frames. */
  story: z.string().default(""),
  /**
   * The story's prevailing emotional tone — a short phrase derived from its theme
   * and arc (e.g. "tender, melancholic, quietly hopeful"), composed into every
   * frame's prompt as a `Mood:` directive unless the frame sets its own `mood`.
   * Keeps mood in ONE inherited place instead of it being re-derived (and
   * drifting) per frame. Optional: existing projects need no migration.
   */
  storyMood: z.string().optional(),
  /** Shared world/setting details. */
  settings: z.string().default(""),
  /**
   * The episode's creative plan (see `EpisodePlanSchema`): structure, art
   * direction, strategy, theme, motif, token. When present, its archetype /
   * theme / motif compose into EVERY frame's prompt as an art-direction block —
   * the lever that makes episodes feel authored around one idea instead of four
   * isolated images. Optional: pre-plan projects parse and compose unchanged.
   */
  plan: EpisodePlanSchema.optional(),
  /** Library series this project is an episode of (a shared visual universe). */
  seriesId: z.string().optional(),
  /** Recurring characters reused across frames for identity consistency. */
  cast: z.array(ComicCharacterSchema).default([]),
  /**
   * Reusable pool of reference images (uploaded or banked from a frame). The artist
   * draws style anchors and character refs from here; entries are content-addressed,
   * so the same image is stored once however many places reference it.
   */
  library: z.array(ComicAssetSchema).default([]),
  style: ComicStyleSchema.default({}),
  promptTemplate: z.string().default(DEFAULT_TEMPLATE),
  frames: z.array(ComicFrameSchema).default([]),
  /**
   * Director-chat history (see `director.ts`): the running conversation with the
   * story director, including the structured changes each turn applied. Lives on
   * the project so snapshots cover it and it travels with the episode. Defaulted
   * so pre-existing projects load unchanged.
   */
  director: z.array(DirectorMessageSchema).default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ComicProject = z.infer<typeof ComicProjectSchema>;

/** Stable compiled node ids for a frame. Keyed by frame.id so reorder/remove is safe. */
export const genNodeId = (frameId: string): string => `gen-${frameId}`;
export const exportNodeId = (frameId: string): string => `export-${frameId}`;
/** Inverse of genNodeId — maps a compiled WS/result node id back to its frame. */
export function frameIdFromNodeId(nodeId: string): string | undefined {
  const m = /^(?:gen|export)-(.+)$/.exec(nodeId);
  return m?.[1];
}

/**
 * A trailing palette directive built from the style's fixed palette, or "" when
 * none is set. Trimmed + blank entries dropped so an empty/whitespace palette emits
 * nothing (same "no dangling label" discipline as the template). Phrased as an
 * instruction so edit/t2i models actually constrain colors rather than treating it
 * as a caption.
 */
export function paletteDirective(palette: string[] | undefined): string {
  const colors = (palette ?? []).map((c) => c.trim()).filter(Boolean);
  if (!colors.length) return "";
  return `Color palette: render using only this limited palette — ${colors.join(", ")}.`;
}

/** Coarse shot-size classes, ordered far → near. The ordered index is the
 *  distance axis `rhythmWarnings` measures camera jumps on. */
export const SHOT_SIZES = ["xws", "wide", "full", "medium", "close", "xcu"] as const;
export type ShotSize = (typeof SHOT_SIZES)[number];

/** Human labels for the shot sizes (the rhythm rail + warning texts). */
export const SHOT_SIZE_LABELS: Record<ShotSize, string> = {
  xws: "extreme wide",
  wide: "wide",
  full: "full",
  medium: "medium",
  close: "close-up",
  xcu: "extreme close-up",
};

/** A ready-to-use camera preset: the human `label` shown in the dropdown and the
 *  prompt-ready `value` fed into `frame.camera`. Grouped angle → distance, coarse to
 *  fine, matching how a shot is usually called. Distance presets carry a coarse
 *  `size` class (the rhythm axis); angle presets don't — they say nothing about
 *  distance, exactly like free text. Free text is still allowed, so the list stays
 *  short and common rather than exhaustive. */
export interface CameraPreset {
  label: string;
  value: string;
  /** Coarse shot-size class, when the preset names a distance. */
  size?: ShotSize;
}
export const CAMERA_PRESETS: CameraPreset[] = [
  // Angle (no size — these frame attitude, not distance)
  { label: "Eye-level", value: "eye-level shot" },
  { label: "Low angle (looking up)", value: "low-angle shot looking up" },
  { label: "High angle (looking down)", value: "high-angle shot looking down" },
  { label: "Bird's-eye (top-down)", value: "bird's-eye view, directly top-down" },
  { label: "Worm's-eye", value: "worm's-eye view from ground level" },
  { label: "Dutch angle (tilted)", value: "dutch angle, tilted horizon" },
  { label: "Over-the-shoulder", value: "over-the-shoulder shot" },
  { label: "Point-of-view (POV)", value: "first-person point-of-view shot" },
  // Distance / shot size
  { label: "Establishing (extreme wide)", value: "extreme wide establishing shot", size: "xws" },
  { label: "Wide shot", value: "wide shot", size: "wide" },
  { label: "Full shot (full body)", value: "full shot, full body in frame", size: "full" },
  { label: "Medium shot (waist up)", value: "medium shot, waist up", size: "medium" },
  { label: "Close-up", value: "close-up", size: "close" },
  { label: "Extreme close-up", value: "extreme close-up", size: "xcu" },
];

/**
 * The frame's coarse shot-size class: the `size` of the camera preset its
 * `camera` phrase matches, or undefined for free text and angle-only presets —
 * those "simply don't participate" in rhythm checks (spec §3.4).
 */
export function cameraSizeOf(frame: ComicFrame): ShotSize | undefined {
  const c = frame.camera?.trim();
  if (!c) return undefined;
  return CAMERA_PRESETS.find((p) => p.value === c)?.size;
}

/**
 * The house craft directive appended to EVERY frame's composed prompt — the
 * "contemporary art machine" baseline. A scene prompt alone ("Batman stands on a
 * rooftop") reads as a caption; with this trailing it becomes an art-directed brief:
 * deliberate cinematic composition, figure work where every posture/gesture/gaze is
 * meaning, motivated light, symbolic staging. Applies to hand-written prompts too,
 * so the house standard doesn't depend on the author (or the draft model) writing
 * painterly prose. Mirrors the CRAFT rules in the draft/director system prompts.
 */
export const CRAFT_DIRECTIVE =
  "Craft: compose this frame like a masterwork — deliberate cinematic staging (dynamic framing, layered depth, intentional negative space), figures whose posture, gesture, hands, gaze and facial expression carry the beat's meaning, motivated lighting, and symbolic objects or environmental detail placed with intention.";

/**
 * The per-role flavor appended to the house craft directive when a frame's
 * `role` is set (spec §5.1) — data, not code paths. Each flavor is one sentence
 * of structural direction: what THIS panel's job is in the strip (the turn
 * takes the biggest camera change; the settle re-stabilizes; the payoff
 * detonates). Hand-written prompts without a role keep the house baseline.
 */
export const ROLE_FLAVORS: Record<FrameRole, string> = {
  establish:
    "This is the establishing panel: read the world — geography and emotional temperature; let the frame breathe; hold the subject back or show it small.",
  develop:
    "This panel must add NEW information — a second read of the space or a real step forward; never restate the previous panel.",
  escalate:
    "Raise the pressure: tighter framing, more kinetic staging, more of the frame filled; the reader should feel the incline.",
  turn:
    "This is the fulcrum: take the episode's biggest camera change and make the status-quo shift visible at a glance.",
  settle:
    "This is the landing: return to a stable, simple composition; one clear image the reader leaves with.",
  payoff:
    "This is the detonation: the panel that retroactively makes the previous panels cohere — dominant, high-contrast, readable at a glance.",
};

/**
 * The craft directive for one frame: the house `CRAFT_DIRECTIVE` sentence,
 * extended by the role's flavor sentence when `role` is set. No role → the
 * house baseline verbatim, so pre-role frames compose byte-identically.
 */
export function craftDirective(role?: FrameRole): string {
  const flavor = role ? ROLE_FLAVORS[role] : undefined;
  return flavor ? `${CRAFT_DIRECTIVE} ${flavor}` : CRAFT_DIRECTIVE;
}

/**
 * The per-gutter transition directive emitted on the ENTERING frame (i ≥ 1),
 * telling the model what kind of bridge the reader must cross from the previous
 * panel (spec §5.2, McCloud's six). Data, not code paths — machinery rather
 * than taxonomy: `action` demands a new camera distance, `scene` forbids a
 * visual bridge, `aspect` strips the subject. Undefined gutter → "".
 */
export const TRANSITION_DIRECTIVES: Record<GutterType, string> = {
  moment:
    "Transition from the previous panel: a heartbeat later — same subject and framing logic, one instant of change.",
  action:
    "Transition: meaningfully later in the same action — same scene and participants, advanced in time; take a NEW camera distance or angle.",
  subject:
    "Transition: within the same scene and beat, the camera cuts to who or what matters now.",
  scene:
    "Transition: a new scene — deliberate jump in place or time; establish the new space cleanly, with no visual bridge to the previous palette.",
  aspect:
    "Transition: an aspect of the same place and mood — no subject, no action; texture, weather, light, objects at rest.",
  nonsequitur:
    "Transition: a hard cut with no literal continuity — the juxtaposition itself is the meaning; commit fully to the new image.",
};

/** The transition directive for a frame's gutter ("" when unset). */
export function transitionDirective(gutter: GutterType | undefined): string {
  return gutter ? TRANSITION_DIRECTIVES[gutter] : "";
}

/**
 * The directive for an echo frame: the echo source's image leads the fed
 * reference order (see `echoReferences`), so "the FIRST attached image" is the
 * episode's opening composition to mirror. Mirrors `continuityDirective`'s
 * identity handling: when the frame also carries character/style sheets, the
 * directive names them as the identity source so likeness never bleeds from
 * the mirrored composition.
 */
export function echoDirective(hasIdentityRefs = false): string {
  const base =
    "Echo: the FIRST attached image is this episode's opening composition — mirror its framing, camera and figure placement, changing exactly what the description above specifies; the mirrored composition IS the payoff.";
  return hasIdentityRefs
    ? `${base} Remaining attached images are the character and style reference sheets: take each character's identity from their own sheet, never from how they appear in the mirrored image.`
    : base;
}

/** The per-frame camera/shot directive appended to a frame's prompt. Trailing period
 *  is normalised so a preset and a hand-typed phrase read identically. Empty → "". */
export function cameraDirective(camera: string | undefined): string {
  const c = (camera ?? "").trim().replace(/\.+$/, "");
  if (!c) return "";
  return `Camera: ${c}.`;
}

/** The per-frame mood directive appended to a frame's prompt. Trailing period is
 *  normalised like `cameraDirective`. Empty/undefined → "". */
export function moodDirective(mood: string | undefined): string {
  const m = (mood ?? "").trim().replace(/\.+$/, "");
  if (!m) return "";
  return `Mood: ${m}.`;
}

/**
 * The episode's art-direction block (spec §5 step 2): one paragraph of up to
 * three lines — archetype, theme, motif — each dropped when its value is empty
 * (the same no-dangling-label discipline as the template). `[]` when the
 * project carries no plan or nothing worth saying; a pre-plan project composes
 * byte-identically to the previous release (golden test).
 */
export function artDirectionLines(plan: EpisodePlan | undefined): string[] {
  if (!plan) return [];
  const lines: string[] = [];
  const archetype = plan.archetype.trim().replace(/\.+$/, "");
  if (archetype) lines.push(`Art direction: ${archetype}.`);
  const theme = plan.theme.trim().replace(/\.+$/, "");
  if (theme) lines.push(`Theme: ${theme}.`);
  const motif = plan.motif.trim();
  if (motif) lines.push(`Motif: weave "${motif}" into this frame only where it earns its place.`);
  return lines;
}

/**
 * Substitute the template tokens for one frame. This is the "engineered context":
 * deterministic, previewable, and identical to what the compiler bakes into the
 * generation node, so the UI preview never diverges from what actually runs.
 *
 * v2 block order (spec §5): template → art direction (plan) → craft (role-flavored)
 * → camera → mood → palette → transition (gutter) → exactly one composition-governing
 * directive (echo > continuity > plain reference). Every block is drop-empty, so a
 * project with no plan/role/gutter/echo composes byte-identically to v1.
 */
export function composeFramePrompt(project: ComicProject, frame: ComicFrame): string {
  const tokens: Record<string, string> = {
    story: project.story,
    settings: project.settings,
    style: project.style.theme,
    frame: frame.prompt,
  };
  const substituted = project.promptTemplate.replace(
    /\{(story|settings|style|frame)\}/g,
    (_, k: string) => tokens[k] ?? "",
  );
  // Drop "Label:" lines whose value expanded to nothing (e.g. an empty `settings`
  // must not emit a dangling "Setting:"), then collapse the blank runs that leaves
  // while preserving single blank lines as paragraph breaks. Clean + deterministic.
  const kept = substituted
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => !/^\s*\p{L}[\p{L} ]*:\s*$/u.test(l));
  const baseText = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();

  // The plan's art direction rides right under the scene text: one episode, one
  // vision, stated to every frame (empty plan/values → nothing, old projects unchanged).
  const art = artDirectionLines(project.plan).join("\n");
  const withArt = art ? (baseText ? `${baseText}\n\n${art}` : art) : baseText;

  // Lead the trailing directives with the house craft standard — now role-flavored:
  // every frame is art-directed like a masterwork, and a framed beat knows its job.
  const craft = craftDirective(frame.role);
  const withCraft = withArt ? `${withArt}\n\n${craft}` : craft;

  // Append this frame's camera/shot framing (if set) right after the scene, so the
  // composition directive sits with the subject it frames. Empty → unchanged prompt.
  const camera = cameraDirective(frame.camera);
  const withCamera = camera ? `${withCraft}\n\n${camera}` : withCraft;

  // Fold in the emotional tone (if any): the frame's own mood, else the story's
  // prevailing mood. A dedicated directive before the palette, so tone is stated
  // once per frame regardless of the template and old projects need no migration.
  const mood = moodDirective(frame.mood ?? project.storyMood);
  const withMood = mood ? (withCamera ? `${withCamera}\n\n${mood}` : mood) : withCamera;

  // Fold in the fixed palette (if any) as a trailing style directive, before the
  // reference directive, so it applies to every frame regardless of the template and
  // old projects (no `{palette}` token needed). The frame's own palette overrides the
  // project-wide one — the per-storyline contrast lever — with an explicit [] dropping
  // the lock; absent inherits `style.palette` (same override shape as mood/storyMood).
  // Empty palette → unchanged prompt.
  const palette = paletteDirective(frame.palette ?? project.style.palette);
  const withPalette = palette ? (withMood ? `${withMood}\n\n${palette}` : palette) : withMood;

  // The typed gutter into this panel (frames i ≥ 1 only): sits BEFORE the reference
  // directives so the gutter's intent frames how the references are used. The first
  // frame has no predecessor, so a stale gutter there emits nothing (defensive).
  const i = project.frames.findIndex((f) => f.id === frame.id);
  const transition = i > 0 ? transitionDirective(frame.gutter) : "";
  const base = transition ? (withPalette ? `${withPalette}\n\n${transition}` : transition) : withPalette;

  // Append exactly one "how to use the reference images" directive, so an edit-capable
  // model knows whether a supplied image is a scene to continue, a layout to copy, or
  // just an identity/style cue — otherwise it silently reproduces whatever it's given.
  // Gated on the same reference sets the compiler feeds, so preview/compile/run match.
  //   • A resolved ECHO governs composition → echo directive (the mirrored opening
  //     leads the fed references; the bookend payout). Echo wins over continuity —
  //     a frame has at most one composition governor, and `rhythmWarnings` flags
  //     the both-set case.
  //   • Else a resolved continuity link governs composition → continuity directive
  //     (which, when cast/style sheets are also present, folds in identity guidance).
  //   • Otherwise, any identity/style references → reference directive (compose/match).
  let directive: string | undefined;
  if (echoReferences(project, frame).length > 0) {
    const hasIdentityRefs = identityReferences(project, frame).length > 0;
    directive = echoDirective(hasIdentityRefs);
  } else if (continuityReferences(project, frame).length > 0) {
    // A continuation frame still carries its cast/style sheets as references; tell the
    // model they're the identity source so character likeness comes from the clean
    // sheet, not from how the character was posed in the previous panel.
    const hasIdentityRefs = identityReferences(project, frame).length > 0;
    directive = continuityDirective(frame.continuesMode ?? DEFAULT_CONTINUES_MODE, hasIdentityRefs);
  } else {
    const idRefs = identityReferences(project, frame);
    if (idRefs.length > 0) {
      // "match" needs to know whether the frame's own layout ref (fed first) is
      // accompanied by cast/style sheets, so the directive can name which image
      // carries the composition and which carry identity.
      const ownHashes = new Set(frame.refHashes);
      const hasIdentitySheets =
        frame.refHashes.length > 0 && idRefs.some((r) => !ownHashes.has(r.hash));
      directive = referenceDirective(
        frame.referenceMode ?? DEFAULT_REFERENCE_MODE,
        hasIdentitySheets,
      );
    }
  }
  if (!directive) return base;
  return base ? `${base}\n\n${directive}` : directive;
}

/**
 * Effective weighted style references for a project: the multi-anchor `anchors`
 * list, or the legacy single `anchorHash` migrated to a full-weight reference when
 * `anchors` is empty. The one place that reconciles old + new projects, so every
 * reader (compiler, UI preview, warnings) sees the same set.
 */
export function styleReferences(style: ComicStyle): ComicReference[] {
  if (style.anchors.length) return style.anchors;
  return style.anchorHash
    ? [{ hash: style.anchorHash, weight: DEFAULT_REFERENCE_WEIGHT }]
    : [];
}

/**
 * The current image of the frame this one continues, as a single full-weight
 * reference (empty when there's no link, it's a self-link, the target was removed,
 * or the target has no image yet). Resolved here so the compiler and UI agree.
 */
export function continuityReferences(
  project: ComicProject,
  frame: ComicFrame,
): ComicReference[] {
  const { continuesFrameId } = frame;
  if (!continuesFrameId || continuesFrameId === frame.id) return [];
  const source = project.frames.find((f) => f.id === continuesFrameId);
  const hash = source && frameImageHash(source);
  return hash ? [{ hash, weight: DEFAULT_CONTINUITY_WEIGHT }] : [];
}

/**
 * The current image of the frame this one echoes (the bookend payout), as a
 * single full-weight reference — empty when there's no link, it's a self-link,
 * the source was removed, or the source has no image yet. Resolved exactly like
 * `continuityReferences` so the compiler, UI preview and wave runner all agree.
 */
export function echoReferences(
  project: ComicProject,
  frame: ComicFrame,
): ComicReference[] {
  const { echoFrameId } = frame;
  if (!echoFrameId || echoFrameId === frame.id) return [];
  const source = project.frames.find((f) => f.id === echoFrameId);
  const hash = source && frameImageHash(source);
  return hash ? [{ hash, weight: DEFAULT_CONTINUITY_WEIGHT }] : [];
}

/**
 * How an in-place image edit treats the base image (fed to an edit-capable model as
 * its leading, full-weight reference). Two intents an edit endpoint treats very
 * differently — the same axis as `ContinuesMode`, but for editing a frame's *own*
 * picture rather than continuing another frame's scene:
 *   "tweak"   → keep the existing artwork almost intact (same composition, camera,
 *               lighting, identity, style) and change ONLY what the instruction asks.
 *   "restage" → keep the look (characters, wardrobe, setting, palette, style) but
 *               allow a new camera angle / pose / blocking to satisfy the instruction.
 */
export type EditMode = "tweak" | "restage";

/** Default edit intent: the conservative "tweak" (change only what's asked). */
export const DEFAULT_EDIT_MODE: EditMode = "tweak";

/**
 * The constraint clause appended after the user's edit instruction, telling an
 * edit-capable model HOW to use the base image (fed as the leading reference). An
 * edit endpoint otherwise defaults to "preserve the canvas and inpaint", which both
 * over-pins a "restage" request and under-specifies a "tweak" one — so the intent
 * must be stated explicitly, exactly as `continuityDirective` does for continuations.
 */
export function editDirective(mode: EditMode): string {
  return mode === "tweak"
    ? "Edit instruction: the reference image is the current artwork — change ONLY what is described above. Preserve everything else exactly: composition, camera angle, framing, lighting, color palette, character identity, wardrobe and art style. Do not redraw or restyle anything that the instruction does not mention."
    : "Edit instruction: apply the change described above, using the reference image as the canonical look — keep the same characters, wardrobe, setting, lighting, color palette, mood and art style. You may re-stage the composition with a new camera angle, posing and blocking as needed to achieve it, but never change character identity or visual style.";
}

/**
 * Compose the prompt for an in-place edit: the artist's change instruction leads,
 * then the mode constraint that tells the edit model how to treat the base image.
 * Mirrors `composeFramePrompt` (instruction-first, directive-trailing) so the edit
 * reads the same way a continuation does. An empty instruction yields just the
 * directive (a bare "tweak"/"restage" of the source).
 */
export function composeEditPrompt(instruction: string, mode: EditMode): string {
  const base = instruction.trim();
  const directive = editDirective(mode);
  return base ? `${base}\n\n${directive}` : directive;
}

/**
 * The ordered, weighted reference set for an in-place edit of `frame`: the chosen
 * base image first at full weight (it dominates — the edit endpoint builds on it),
 * then, when `keepStyle`, the identity refs of the frame's active cast and the project's
 * style references (so the characters and look stay consistent through the edit). Cast
 * leads style for the same reason as `frameReferences`: if the adapter truncates the
 * tail at the model's image cap, the likeness outranks the look. Deduped by hash, base
 * first, so the base keeps its leading position even if it's
 * also a style/character ref. Unlike `frameReferences` there is no continuity ref —
 * an edit operates on its own explicit base, not a continued scene.
 */
export function editReferences(
  project: ComicProject,
  frame: ComicFrame,
  baseHash: string,
  keepStyle: boolean,
): ComicReference[] {
  const base: ComicReference = { hash: baseHash, weight: DEFAULT_REFERENCE_WEIGHT };
  if (!keepStyle) return [base];
  const ids = frame.characterIds;
  const activeCast =
    ids === undefined ? project.cast : project.cast.filter((c) => ids.includes(c.id));
  const characterRefs = activeCast.flatMap((c) =>
    // Cap per character so one big sheet doesn't monopolise the reference budget.
    c.refHashes
      .slice(0, MAX_REFS_PER_CHARACTER)
      .map((hash) => ({ hash, weight: DEFAULT_REFERENCE_WEIGHT })),
  );
  const byHash = new Map<string, ComicReference>();
  for (const ref of [
    base,
    ...frameOwnReferences(frame),
    ...characterRefs,
    ...styleReferences(project.style),
  ]) {
    if (!byHash.has(ref.hash)) byHash.set(ref.hash, ref);
  }
  return [...byHash.values()];
}

/** A request to edit one frame's image in place. See `compileEditFrame`. */
export interface EditFrameRequest {
  /** The image to edit (a hash in the asset store — a frame variant or an upload). */
  baseHash: string;
  /** What to change ("she leans back; lower camera angle"). */
  instruction: string;
  /** How freely to deviate from the base (defaults to `DEFAULT_EDIT_MODE`). */
  mode?: EditMode;
  /** Per-edit seed (defaults to the frame's, then the project's locked seed). */
  seed?: number;
  /** Carry the project's style refs + active cast as secondary references (default true). */
  keepStyle?: boolean;
}

/**
 * Lower a single in-place edit to a runnable one-node GraphDocument: a lone
 * generation node (no export — its bytes land in the asset store and the hash is read
 * back from the run result). The node id is the frame's own `genNodeId`, so live
 * progress + preview events route to the frame exactly as a normal run does, and the
 * base image leads the reference set so an edit-capable model edits it in place.
 */
export function compileEditFrame(
  project: ComicProject,
  frame: ComicFrame,
  req: EditFrameRequest,
): GraphDocument {
  const { style } = project;
  const mode = req.mode ?? DEFAULT_EDIT_MODE;
  const keepStyle = req.keepStyle ?? true;
  const references = editReferences(project, frame, req.baseHash, keepStyle);
  // Style LoRAs + the active cast's character LoRAs (same compose as a normal frame).
  const loras = frameLoras(project, frame).map((l) => ({ path: l.path, scale: l.scale }));

  return GraphDocumentSchema.parse({
    version: 1,
    id: `comic-${project.id}-edit-${frame.id}`,
    name: `${project.name} · edit`,
    nodes: [
      {
        id: genNodeId(frame.id),
        type: "generate.text-to-image",
        position: { x: 0, y: 0 },
        params: {
          model: style.model,
          prompt: composeEditPrompt(req.instruction, mode),
          negativePrompt: style.negative,
          width: style.width,
          height: style.height,
          seed: req.seed ?? frame.seed ?? style.seed,
          references,
          ...(loras.length ? { loras } : {}),
        },
        title: `Edit ${frame.id}`,
      },
    ],
    edges: [],
  });
}

/** This frame's own attached reference images as full-weight references (its
 *  `refHashes`, in order). Per-frame look/composition guidance, distinct from the
 *  project-wide style anchors and the shared cast. */
export function frameOwnReferences(frame: ComicFrame): ComicReference[] {
  return frame.refHashes.map((hash) => ({ hash, weight: DEFAULT_REFERENCE_WEIGHT }));
}

/**
 * The frame's identity/style references — everything that defines its *look* rather
 * than continuing a prior scene: this frame's own attached refs first (per-frame
 * guidance), then the identity refs of each active cast member (character consistency,
 * full weight, capped at `MAX_REFS_PER_CHARACTER` so one big sheet can't dominate the
 * budget), then the project's style references (look consistency). Ordered
 * (earlier = stronger) and deduped by hash (first wins). Character refs deliberately
 * lead style: when a model caps the number of input images and the adapter truncates
 * the tail (see `maxReferences` in the fal adapter), the look — also carried by the
 * continuity frame and style LoRAs — is dropped before a character's likeness. This is
 * the set governed by `referenceMode`/`referenceDirective`; `frameReferences` prepends
 * scene continuity.
 */
export function identityReferences(project: ComicProject, frame: ComicFrame): ComicReference[] {
  const ids = frame.characterIds;
  const activeCast =
    ids === undefined ? project.cast : project.cast.filter((c) => ids.includes(c.id));
  const characterRefs = activeCast.flatMap((c) =>
    // Cap per character so one big sheet doesn't monopolise the reference budget.
    c.refHashes
      .slice(0, MAX_REFS_PER_CHARACTER)
      .map((hash) => ({ hash, weight: DEFAULT_REFERENCE_WEIGHT })),
  );
  const byHash = new Map<string, ComicReference>();
  for (const ref of [
    ...frameOwnReferences(frame),
    ...characterRefs,
    ...styleReferences(project.style),
  ]) {
    if (!byHash.has(ref.hash)) byHash.set(ref.hash, ref);
  }
  return [...byHash.values()];
}

/**
 * The full ordered, weighted reference set for one frame: the echo reference
 * first (a resolved bookend governs composition, so the mirrored opening leads
 * at full weight — it would otherwise fight the continuity frame for the lead),
 * then the scene-continuity reference, then the frame's identity/style
 * references (own refs → active cast → style). Order matters — models weight
 * earlier references more, and adapters that cap input images truncate the
 * tail — so echo leads, continuity follows, then the frame's own refs, then
 * characters, then style (the most expendable, also carried by LoRAs). Deduped
 * by hash (first wins, so an image used in two roles keeps its
 * strongest/earliest weight and is sent once). Shared by the compiler and the
 * UI preview so what runs is exactly what the artist sees.
 */
export function frameReferences(project: ComicProject, frame: ComicFrame): ComicReference[] {
  const byHash = new Map<string, ComicReference>();
  for (const ref of [
    ...echoReferences(project, frame),
    ...continuityReferences(project, frame),
    ...identityReferences(project, frame),
  ]) {
    if (!byHash.has(ref.hash)) byHash.set(ref.hash, ref);
  }
  return [...byHash.values()];
}

/** Just the ordered, deduped reference hashes for a frame (drops weights). */
export function frameReferenceHashes(project: ComicProject, frame: ComicFrame): string[] {
  return frameReferences(project, frame).map((ref) => ref.hash);
}

/**
 * The LoRAs that apply to one frame: the project's fixed **style** LoRAs (every
 * frame) plus the **character** LoRA of each cast member active in this frame
 * (membership via `characterIds`, same tri-state as references). Style LoRAs lead
 * (the look is the stable base), character LoRAs follow; deduped by path (first
 * wins). Blank paths are dropped. This is the *style axis × identity axis* compose:
 * a character keeps her trained identity across whatever style the project wears.
 */
export function frameLoras(project: ComicProject, frame: ComicFrame): ComicLora[] {
  const ids = frame.characterIds;
  const activeCast =
    ids === undefined ? project.cast : project.cast.filter((c) => ids.includes(c.id));
  const characterLoras: ComicLora[] = activeCast
    .filter((c) => c.loraPath?.trim())
    .map((c) => ({ path: c.loraPath!, scale: c.loraScale ?? 1, name: c.loraName || c.name }));

  const byPath = new Map<string, ComicLora>();
  for (const lora of [...project.style.loras, ...characterLoras]) {
    if (lora.path.trim() && !byPath.has(lora.path)) byPath.set(lora.path, lora);
  }
  return [...byPath.values()];
}

// ---------------------------------------------------------------------------
// Structure reconciliation & review notes (advisory — never blocking)
// ---------------------------------------------------------------------------

/** Gutters that continue the previous scene (auto-link to the predecessor). */
const LINKING_GUTTERS: ReadonlySet<GutterType> = new Set(["moment", "action", "subject"]);

/**
 * Reconcile typed gutters with continuity links so the two can never contradict
 * each other (spec §3.3, "the important one"). Applied to freshly mapped frames
 * (draft apply / ingest); pure, so it's testable and reusable:
 *   • `moment|action|subject` with no `continuesFrameId` auto-links to frame
 *     i−1 — the table says these gutters keep the previous scene as reference.
 *     An EXISTING link is authoritative and kept, including a non-adjacent one
 *     (the framed-tale return: P4 `action`-continuing P1).
 *   • `scene|aspect|nonsequitur` clear an ADJACENT link (exactly what an
 *     auto-link would be — these gutters mean "no continuity reference"), but
 *     never a non-adjacent explicit one.
 * The first frame has no predecessor, so it is passed through untouched. Returns
 * a new array; frames are copied only when changed.
 */
export function gutterReconcile(frames: readonly ComicFrame[]): ComicFrame[] {
  return frames.map((f, i) => {
    if (i === 0 || !f.gutter) return f;
    const prev = frames[i - 1]!;
    if (LINKING_GUTTERS.has(f.gutter)) {
      // A self-link is junk (compile drops it anyway), not an authoritative link —
      // so it shapes like "no link" and auto-links to the predecessor.
      return f.continuesFrameId && f.continuesFrameId !== f.id
        ? f
        : { ...f, continuesFrameId: prev.id };
    }
    // scene/aspect/nonsequitur: drop an adjacent (auto-shaped) link; a
    // non-adjacent explicit link survives (it names another scene to return to).
    return f.continuesFrameId === prev.id || f.continuesFrameId === f.id
      ? { ...f, continuesFrameId: undefined }
      : f;
  });
}

/**
 * Advisory review notes for the episode's rhythm (spec §3.3–§3.5) — surfaced in
 * the DraftModal and the Studio rhythm rail; they advise, the author decides.
 * Accepts any `{ frames }` project-shape so a not-yet-applied draft can be
 * checked too. Free-text cameras simply don't participate.
 *   • adjacent identical preset shot sizes (a `moment` gutter legitimately
 *     holds the same framing — one instant of change),
 *   • P3 not taking the episode's biggest size-jump (the turn is the fulcrum),
 *   • gutter budget: more than one `scene`, `aspect` past the first half,
 *     total reader effort over `GUTTER_EFFORT_MAX`,
 *   • a frame setting BOTH an echo and a continuity link (echo governs; the
 *     contradiction deserves eyes).
 */
export function rhythmWarnings(project: Pick<ComicProject, "frames">): string[] {
  const { frames } = project;
  const notes: string[] = [];

  const sizes = frames.map((f) => cameraSizeOf(f));
  for (let i = 1; i < frames.length; i++) {
    const a = sizes[i - 1]!;
    const b = sizes[i]!;
    if (a && b && a === b && frames[i]!.gutter !== "moment") {
      notes.push(
        `Frames ${i} & ${i + 1} repeat the same ${SHOT_SIZE_LABELS[b]!} shot — change the distance or angle, or mark the gutter "moment".`,
      );
    }
  }

  // Advisory: of the adjacent pairs where both cameras carry a size, the jump
  // INTO P3 should be the largest in the episode (the craft-codex fulcrum rule).
  const jumps = frames
    .map((_, i) => {
      if (i === 0) return undefined;
      const a = sizes[i - 1]!;
      const b = sizes[i]!;
      return a && b
        ? { into: i, gap: Math.abs(SHOT_SIZES.indexOf(a) - SHOT_SIZES.indexOf(b)) }
        : undefined;
    })
    .filter((j): j is { into: number; gap: number } => !!j);
  const intoP3 = jumps.find((j) => j.into === 2);
  if (intoP3 && jumps.some((j) => j.gap > intoP3.gap)) {
    notes.push(
      "Frame 3 isn't the episode's biggest camera change — the turn panel should take the largest jump in shot size.",
    );
  }

  const sceneCount = frames.filter((f) => f.gutter === "scene").length;
  if (sceneCount > 1) {
    notes.push(`${sceneCount} scene jumps — at most one per strip keeps the reader oriented.`);
  }
  frames.forEach((f, i) => {
    if (f.gutter === "aspect" && i >= 2) {
      notes.push(`Frame ${i + 1} is an aspect panel — aspects read best in the first half of the strip.`);
    }
    if (f.echoFrameId && f.continuesFrameId) {
      notes.push(
        `Frame ${i + 1} sets both an echo and a continuity link — the echo governs composition; clear one of the two.`,
      );
    }
  });
  const effort = frames.reduce((sum, f) => sum + (f.gutter ? GUTTER_EFFORT[f.gutter] : 0), 0);
  if (effort > GUTTER_EFFORT_MAX) {
    notes.push(
      `High reader effort (gutters score ${effort} of ${GUTTER_EFFORT_MAX}) — lean on action transitions; save the hard cuts for the payoff.`,
    );
  }
  return notes;
}

export interface CompileComicOptions {
  /** Directory the export nodes write frame images to (e.g. the project's frames/ dir). */
  exportDir?: string;
  /** Image format for exported frames. */
  format?: "png" | "jpeg" | "webp";
}

/**
 * Lower a comic project to a runnable GraphDocument. Each frame becomes a
 * generation node → export node pair with ids derived from the frame id, so the
 * content-addressed cache makes re-running an unchanged frame free and live
 * progress events route back to the right frame.
 */
export function compileComic(
  project: ComicProject,
  opts: CompileComicOptions = {},
): GraphDocument {
  const { style } = project;
  const format = opts.format ?? "png";

  const nodes: GraphDocument["nodes"] = [];
  const edges: GraphDocument["edges"] = [];

  project.frames.forEach((frame, i) => {
    const gid = genNodeId(frame.id);
    const eid = exportNodeId(frame.id);
    const x = i * 360;
    const references = frameReferences(project, frame);
    // Per-frame: style LoRAs + the active cast members' character LoRAs.
    const loras = frameLoras(project, frame).map((l) => ({ path: l.path, scale: l.scale }));

    nodes.push({
      id: gid,
      type: "generate.text-to-image",
      position: { x, y: 0 },
      params: {
        model: style.model,
        prompt: composeFramePrompt(project, frame),
        negativePrompt: style.negative,
        width: style.width,
        height: style.height,
        seed: frame.seed ?? style.seed,
        ...(references.length ? { references } : {}),
        ...(loras.length ? { loras } : {}),
      },
      title: `Frame ${i + 1}`,
    });

    nodes.push({
      id: eid,
      type: "io.export",
      position: { x, y: 320 },
      params: {
        dir: opts.exportDir ?? "out",
        filename: `frame-${i + 1}`,
        format,
      },
      title: `Export ${i + 1}`,
    });

    edges.push({
      id: `e-${frame.id}`,
      source: gid,
      sourcePort: "image",
      target: eid,
      targetPort: "image",
    });
  });

  return GraphDocumentSchema.parse({
    version: 1,
    id: `comic-${project.id}`,
    name: project.name,
    nodes,
    edges,
  });
}
