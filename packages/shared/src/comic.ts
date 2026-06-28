import { z } from "zod";
import { GraphDocumentSchema, type GraphDocument } from "./graph.js";

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
  /** Identity reference image hashes (most-distinctive first; models weight earlier refs higher). */
  refHashes: z.array(z.string().length(64)).default([]),
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

/** Influence weight of a scene-continuity reference. Full strength by design: a
 *  continuation must lock the prior scene hard, so it leads at maximum weight. */
export const DEFAULT_CONTINUITY_WEIGHT = 1;

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
  negative: z.string().default(DEFAULT_NEGATIVE),
});
export type ComicStyle = z.infer<typeof ComicStyleSchema>;

export const ComicProjectSchema = z.object({
  version: z.literal(1).default(1),
  id: z.string().min(1),
  name: z.string().default("Untitled comic"),
  /** The overall narrative arc — context for continuity across frames. */
  story: z.string().default(""),
  /** Shared world/setting details. */
  settings: z.string().default(""),
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
 * Substitute the template tokens for one frame. This is the "engineered context":
 * deterministic, previewable, and identical to what the compiler bakes into the
 * generation node, so the UI preview never diverges from what actually runs.
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
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
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
 * The full ordered, weighted reference set for one frame: the scene-continuity
 * reference first (this frame continues another's scene, so it leads at full
 * weight), then the project's style references (look consistency), then the
 * identity refs of each cast member active in the frame (character consistency,
 * full weight). Order matters — models weight earlier references more — so
 * continuity leads, style follows, characters last. Deduped by hash (first wins,
 * so an image used in two roles keeps its strongest/earliest weight and is sent
 * once). Shared by the compiler and the UI preview so what runs is exactly what
 * the artist sees.
 */
export function frameReferences(project: ComicProject, frame: ComicFrame): ComicReference[] {
  const ids = frame.characterIds;
  const activeCast =
    ids === undefined ? project.cast : project.cast.filter((c) => ids.includes(c.id));
  const characterRefs = activeCast.flatMap((c) =>
    c.refHashes.map((hash) => ({ hash, weight: DEFAULT_REFERENCE_WEIGHT })),
  );
  const byHash = new Map<string, ComicReference>();
  for (const ref of [
    ...continuityReferences(project, frame),
    ...styleReferences(project.style),
    ...characterRefs,
  ]) {
    if (!byHash.has(ref.hash)) byHash.set(ref.hash, ref);
  }
  return [...byHash.values()];
}

/** Just the ordered, deduped reference hashes for a frame (drops weights). */
export function frameReferenceHashes(project: ComicProject, frame: ComicFrame): string[] {
  return frameReferences(project, frame).map((ref) => ref.hash);
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
  // House-style LoRAs shared by every frame (drop blank-path rows; only path+scale run).
  const loras = style.loras
    .filter((l) => l.path.trim())
    .map((l) => ({ path: l.path, scale: l.scale }));

  const nodes: GraphDocument["nodes"] = [];
  const edges: GraphDocument["edges"] = [];

  project.frames.forEach((frame, i) => {
    const gid = genNodeId(frame.id);
    const eid = exportNodeId(frame.id);
    const x = i * 360;
    const references = frameReferences(project, frame);

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
