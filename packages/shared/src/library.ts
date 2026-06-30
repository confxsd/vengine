import { z } from "zod";
import {
  ComicLoraSchema,
  ComicReferenceSchema,
  DEFAULT_HEIGHT,
  DEFAULT_NEGATIVE,
  DEFAULT_WIDTH,
} from "./comic.js";
import { SceneReferenceSchema, SeriesSchema } from "./scene.js";

/**
 * The **cross-project library**: durable creative assets that outlive any single
 * comic — recurring characters (Yue, "the boy", guest stars), reusable style packs
 * (oil, ink, comic), and trained LoRAs. Projects *reference* these by id (with
 * optional local overrides), so a character/style is defined once and reused
 * everywhere instead of being copied into — and drifting across — each project.
 *
 * Persisted as a single JSON document by @vengine/storage `LibraryStore`. Image
 * bytes live in the existing content-addressed asset store (global, so a `refHash`
 * resolves from any project), so the library only stores hashes + metadata.
 */

/** ISO-8601 timestamps; the server stamps these (clients never author time). */
const isoString = z.string();

/**
 * Single source of truth for the string discriminators used across the server,
 * client and wire — so a `kind`/`status` comparison is never a bare literal that can
 * typo or drift between packages. Each is a frozen `as const` object plus a derived
 * union type; the ones fed to `z.enum` (status, kind) also expose a value tuple.
 */

/** Lifecycle states of a trained LoRA / training job. */
export const TrainingStatus = {
  Training: "training",
  Ready: "ready",
  Failed: "failed",
} as const;
export type TrainingStatus = (typeof TrainingStatus)[keyof typeof TrainingStatus];
const TRAINING_STATUS_VALUES = Object.values(TrainingStatus) as [TrainingStatus, ...TrainingStatus[]];

/** What a LoRA teaches: an identity (subject) or a look (style). */
export const LoraKind = {
  Subject: "subject",
  Style: "style",
} as const;
export type LoraKind = (typeof LoraKind)[keyof typeof LoraKind];
const LORA_KIND_VALUES = Object.values(LoraKind) as [LoraKind, ...LoraKind[]];

/** Discriminators for events multiplexed over the shared progress WebSocket. */
export const WsEventKind = {
  Training: "training",
} as const;
export type WsEventKind = (typeof WsEventKind)[keyof typeof WsEventKind];

/**
 * A trained LoRA produced by a fal trainer — the strongest identity/style lock.
 * `loraUrl` is exactly a generation `LoraInput.path`, so a ready model drops
 * straight into a project's `style.loras` or a character's `loraId`. A record is
 * created when training *starts* (`status: "training"`) and updated on completion,
 * so the library can show in-flight jobs, not just finished weights.
 */
export const TrainedLoraSchema = z.object({
  id: z.string().min(1),
  name: z.string().default(""),
  /** "subject" = a character/identity LoRA; "style" = a look LoRA. */
  kind: z.enum(LORA_KIND_VALUES).default(LoraKind.Subject),
  /** Trainer adapter id that produced it, e.g. "fal/flux-2-trainer". */
  trainerId: z.string().default(""),
  /** Inference model id this LoRA is compatible with, e.g. "fal/flux-2-lora". */
  baseModelId: z.string().default(""),
  /** Activation token at inference (FLUX.1 trainer); empty for caption-only trainers. */
  trigger: z.string().default(""),
  /** Hosted weights URL — feeds `LoraInput.path`. Empty until training completes. */
  loraUrl: z.string().default(""),
  /** fal training-config URL (provenance). */
  configUrl: z.string().default(""),
  /** Asset hashes used to train it (reproducibility + "retrain"). */
  datasetHashes: z.array(z.string().length(64)).default([]),
  steps: z.number().int().nonnegative().default(0),
  costUsd: z.number().nonnegative().default(0),
  status: z.enum(TRAINING_STATUS_VALUES).default(TrainingStatus.Training),
  /** Failure reason when `status === "failed"`. */
  error: z.string().default(""),
  /**
   * Durable vendor job handle, persisted while `status === "training"` so the server
   * can **resume polling after a restart** (fal keeps running the job; we re-attach
   * by its id/URLs). `jobStatusUrl`/`jobResponseUrl` are fal's authoritative URLs —
   * not reconstructed — captured at submit. Cleared/ignored once terminal.
   */
  jobId: z.string().default(""),
  jobEndpoint: z.string().default(""),
  jobStatusUrl: z.string().default(""),
  jobResponseUrl: z.string().default(""),
  createdAt: isoString.optional(),
  updatedAt: isoString.optional(),
});
export type TrainedLora = z.infer<typeof TrainedLoraSchema>;

/**
 * A recurring character. A superset of the per-project `ComicCharacter`: it adds an
 * identity `description`, a `palette` (e.g. Yue's fur/eye hex codes — text identity
 * locks alongside the image refs), and an optional `loraId` pointing at a trained
 * subject LoRA in this same library. A project's cast entry links here by
 * `libraryId`; `refHashes`/description can be overridden locally without editing the
 * shared character.
 */
export const LibraryCharacterSchema = z.object({
  id: z.string().min(1),
  name: z.string().default(""),
  /** Identity-establishing image hashes (most-distinctive first; models weight earlier higher). */
  refHashes: z.array(z.string().length(64)).default([]),
  /** Freeform identity text fed alongside the refs ("an exiled moon-goddess in rabbit form…"). */
  description: z.string().default(""),
  /** Palette anchors as text (hexes/labels) — strengthens identity beyond the images. */
  palette: z.array(z.string()).default([]),
  /** Optional trained subject LoRA for this character (id into `Library.trainedLoras`). */
  loraId: z.string().optional(),
  tags: z.array(z.string()).default([]),
  createdAt: isoString.optional(),
  updatedAt: isoString.optional(),
});
export type LibraryCharacter = z.infer<typeof LibraryCharacterSchema>;

/**
 * A reusable **style pack** — the decoupling that frees the engine from "comics".
 * It bundles everything that defines a look so it can be applied to any project:
 * the `theme` text, the `negative` (crucially per-style: the comic "no marks"
 * negative is *wrong* for oil/ink, which want visible texture), default dimensions,
 * a `recommendedModelId` (some looks need a specific model), weighted style anchors,
 * and style LoRAs. Applying a pack writes these into `project.style`.
 */
export const StylePackSchema = z.object({
  id: z.string().min(1),
  name: z.string().default(""),
  theme: z.string().default(""),
  /** Per-style negative. NOT the global comic default — oil/ink override it. */
  negative: z.string().default(""),
  width: z.number().int().positive().default(DEFAULT_WIDTH),
  height: z.number().int().positive().default(DEFAULT_HEIGHT),
  /** Model this look is tuned for (e.g. a painterly model); empty = leave the project's. */
  recommendedModelId: z.string().default(""),
  anchors: z.array(ComicReferenceSchema).default([]),
  loras: z.array(ComicLoraSchema).default([]),
  tags: z.array(z.string()).default([]),
  /** True for shipped presets (Comic / Oil / Ink) so the UI can mark them read-only-ish. */
  builtIn: z.boolean().default(false),
  createdAt: isoString.optional(),
  updatedAt: isoString.optional(),
});
export type StylePack = z.infer<typeof StylePackSchema>;

/**
 * Shipped style presets that **decouple the engine from comics**. Each carries its
 * OWN negative — the key fix: the comic "no text / no panel border" negative is wrong
 * for painterly looks, which *want* visible brushwork and marks. The server seeds
 * these once (then they're user-editable). Stable ids so re-seeding never duplicates.
 */
export function builtinStylePacks(): StylePack[] {
  const pack = (p: Partial<StylePack> & { id: string }) => StylePackSchema.parse({ builtIn: true, ...p });
  return [
    pack({
      id: "builtin-comic",
      name: "Contemporary Comic",
      theme:
        "contemporary-art comic illustration, bold confident ink linework, flat cel shading, dramatic high-contrast composition, limited expressive palette",
      // The original comic negative now lives HERE, not as a global default.
      negative: DEFAULT_NEGATIVE,
      width: DEFAULT_WIDTH,
      height: DEFAULT_HEIGHT,
    }),
    pack({
      id: "builtin-oil",
      name: "Oil Painting",
      theme:
        "traditional oil painting, thick impasto, visible directional brushwork, rich canvas texture, luminous layered glazes, warm classical palette, painterly edges",
      // Painterly looks want texture/marks — so NO "no marks" negative; only reject
      // the clean/synthetic looks that would flatten the medium.
      negative: "photographic, 3d render, flat vector, smooth airbrush, plastic, low texture",
      width: 1024,
      height: 1280,
    }),
    pack({
      id: "builtin-ink",
      name: "Ancient Chinese Ink",
      theme:
        "ancient Chinese ink wash painting (shuimo), expressive sumi brush strokes, generous negative space, subtle ink gradients, muted earth and stone tones, mythic atmospheric depth",
      negative: "photographic, 3d render, neon, oversaturated, hard outlines, cluttered",
      width: 896,
      height: 1280,
    }),
    pack({
      id: "builtin-watercolor",
      name: "Watercolor",
      theme:
        "delicate watercolor painting, soft translucent washes, bleeding wet-on-wet pigments, visible paper grain, airy light palette",
      negative: "photographic, 3d render, harsh outlines, heavy black, digital gradient",
      width: 1024,
      height: 1280,
    }),
  ];
}

/** The whole library document (one JSON file). Collections default to empty so a
 *  fresh install reads as a valid, empty library rather than erroring. */
export const LibrarySchema = z.object({
  characters: z.array(LibraryCharacterSchema).default([]),
  styles: z.array(StylePackSchema).default([]),
  trainedLoras: z.array(TrainedLoraSchema).default([]),
  /** Saved scene references (image→text breakdowns). Defaulted so existing
   *  documents written before this field load as valid, empty collections. */
  scenes: z.array(SceneReferenceSchema).default([]),
  /** Long-form groupings of projects sharing a cast + default style. */
  series: z.array(SeriesSchema).default([]),
});
export type Library = z.infer<typeof LibrarySchema>;

/** An empty library — the default when no document exists yet. */
export function emptyLibrary(): Library {
  return { characters: [], styles: [], trainedLoras: [], scenes: [], series: [] };
}

/**
 * WS event pushed on every training-state transition. `kind` discriminates it from
 * node progress events on the shared socket. The client treats it as a *hint* to
 * update its view — the persisted library (via `GET /api/library`) is the source of
 * truth, so a dropped socket loses nothing: on reconnect the client just refetches.
 */
export interface TrainingProgressEvent {
  kind: typeof WsEventKind.Training;
  lora: TrainedLora;
  at: string;
}

/** Build a training WS event (one place that stamps `kind`). */
export function trainingEvent(lora: TrainedLora, at: string): TrainingProgressEvent {
  return { kind: WsEventKind.Training, lora, at };
}

/**
 * Type guard for a training event on the shared socket — the client uses this to
 * pick training frames out of the multiplexed stream instead of testing a bare
 * `e.kind === "training"` string. Narrows to `TrainingProgressEvent`.
 */
export function isTrainingEvent(e: unknown): e is TrainingProgressEvent {
  return (
    typeof e === "object" &&
    e !== null &&
    (e as { kind?: unknown }).kind === WsEventKind.Training &&
    "lora" in e
  );
}
