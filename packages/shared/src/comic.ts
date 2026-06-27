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

export const ComicFrameSchema = z.object({
  /** Stable id (never the array index): node ids + WS routing + result mapping key off this. */
  id: z.string().min(1),
  /** This frame's specific scene prompt. */
  prompt: z.string().default(""),
  /** Optional per-frame seed; falls back to the project's locked style seed. */
  seed: z.number().int().optional(),
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

export const ComicStyleSchema = z.object({
  /** Broad visual style theme applied to every frame (the consistency anchor in text form). */
  theme: z.string().default(""),
  /** Generation model id (provider registry key). */
  model: z.string().default("mock/gradient"),
  /** Locked seed shared across frames for look-consistency. */
  seed: z.number().int().default(42),
  width: z.number().int().positive().default(DEFAULT_WIDTH),
  height: z.number().int().positive().default(DEFAULT_HEIGHT),
  /** Optional style-anchor reference image (asset hash), fed into every frame. */
  anchorHash: z.string().length(64).optional(),
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
  const referenceHashes = style.anchorHash ? [style.anchorHash] : [];

  const nodes: GraphDocument["nodes"] = [];
  const edges: GraphDocument["edges"] = [];

  project.frames.forEach((frame, i) => {
    const gid = genNodeId(frame.id);
    const eid = exportNodeId(frame.id);
    const x = i * 360;

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
        ...(referenceHashes.length ? { referenceHashes } : {}),
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
