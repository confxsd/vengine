import { z } from "zod";
import {
  ComicVariantSchema,
  composeEditPrompt,
  paletteDirective,
  referenceDirective,
  unionVariants,
  DEFAULT_REFERENCE_WEIGHT,
  type ComicLora,
  type ComicReference,
  type ComicVariant,
  type EditMode,
} from "./comic.js";
import { GraphDocumentSchema, type GraphDocument } from "./graph.js";

/**
 * The **character system**: a per-character design workspace that expands one
 * library character into a structured reference system — pose studies, expression
 * sheets, turnarounds, wardrobe, symbols/motifs, key-art compositions and props.
 * Each *study* is a titled, categorised exploration with its own prompt and a
 * variant history (same shape as a comic frame's), generated with the character's
 * identity locks (reference images, description, palette, subject LoRA) so every
 * output belongs to the same visual system.
 *
 * Studies live inside `LibraryCharacter.studies` (see library.ts) so the whole
 * system travels with the character, and any study image — being a plain asset
 * hash — can be promoted into the character's identity refs or attached anywhere
 * else in the studio.
 */

/** ISO-8601 timestamps; the server stamps these (clients never author time). */
const isoString = z.string();

/** The shelves a study can live on — the professional character-design taxonomy. */
export const StudyCategory = {
  Pose: "pose",
  Expression: "expression",
  Turnaround: "turnaround",
  Wardrobe: "wardrobe",
  Symbol: "symbol",
  Composition: "composition",
  Prop: "prop",
} as const;
export type StudyCategory = (typeof StudyCategory)[keyof typeof StudyCategory];
export const STUDY_CATEGORY_VALUES = Object.values(StudyCategory) as [
  StudyCategory,
  ...StudyCategory[],
];

/**
 * Per-category authoring metadata: the UI label/hint and the **directive** that
 * frames the user's prompt as that kind of design study (clean background for
 * sheet-type studies, full scene for key art), plus the canvas each category
 * wants (a turnaround is landscape, a pose sheet portrait, a symbol square).
 * All dimensions are multiples of 16 (SDXL/fal-friendly).
 */
export interface StudyCategoryMeta {
  value: StudyCategory;
  label: string;
  /** One-line composer hint ("what do I type here?"). */
  hint: string;
  /** The design-study framing appended after the user's prompt. */
  directive: string;
  width: number;
  height: number;
}

export const STUDY_CATEGORIES: Record<StudyCategory, StudyCategoryMeta> = {
  [StudyCategory.Pose]: {
    value: StudyCategory.Pose,
    label: "Pose",
    hint: "A stance or action — “leaping mid-air, robes trailing”",
    directive:
      "Character design study — full-body pose: render the character's complete figure in the pose described, fully in frame head to toe, on a clean neutral studio background with no scenery.",
    width: 832,
    height: 1216,
  },
  [StudyCategory.Expression]: {
    value: StudyCategory.Expression,
    label: "Expression",
    hint: "A feeling on the face — “quiet fury, eyes narrowed”",
    directive:
      "Character design study — facial expression: a head-and-shoulders portrait capturing the expression described, on a clean neutral background.",
    width: 1024,
    height: 1024,
  },
  [StudyCategory.Turnaround]: {
    value: StudyCategory.Turnaround,
    label: "Turnaround",
    hint: "A model-sheet view set — “neutral stance, travel cloak”",
    directive:
      "Character model sheet — turnaround: the same character at consistent scale arranged in a single row — front view, three-quarter view, side profile and back view — standing in the neutral pose described, on a clean neutral background.",
    width: 1344,
    height: 768,
  },
  [StudyCategory.Wardrobe]: {
    value: StudyCategory.Wardrobe,
    label: "Wardrobe",
    hint: "An outfit or costume — “ceremonial moon-festival robes”",
    directive:
      "Character design study — costume: the character's complete figure presenting the outfit described, fully in frame, on a clean neutral background.",
    width: 832,
    height: 1216,
  },
  [StudyCategory.Symbol]: {
    value: StudyCategory.Symbol,
    label: "Symbol",
    hint: "An emblem or motif — “crescent-moon sigil in jade”",
    directive:
      "Iconography study — a symbol from this character's visual language: render the emblem or motif described as a bold, readable mark, centered on a clean background, consistent with the character's palette and world.",
    width: 1024,
    height: 1024,
  },
  [StudyCategory.Composition]: {
    value: StudyCategory.Composition,
    label: "Composition",
    hint: "A key-art scene — “alone on a rooftop under a full moon”",
    directive:
      "Key-art composition study: a full illustrated scene as described, featuring the character; composition, camera and staging follow the description.",
    width: 768,
    height: 1344,
  },
  [StudyCategory.Prop]: {
    value: StudyCategory.Prop,
    label: "Prop",
    hint: "An object from their world — “her carved jade hairpin”",
    directive:
      "Prop design study: the object described rendered as a clean design reference, centered on a neutral background, consistent with the character's world and palette.",
    width: 1024,
    height: 1024,
  },
};

/**
 * One study in a character's system: a categorised, titled exploration with its
 * own prompt and generation history. `variants`/`resultHash` mirror a comic
 * frame's output model exactly (selection + capped history, server-authoritative
 * via `mergeStudies`), so the whole variant UX carries over unchanged.
 */
export const CharacterStudySchema = z.object({
  id: z.string().min(1),
  category: z.enum(STUDY_CATEGORY_VALUES).default(StudyCategory.Pose),
  /** UI name for the shelf ("Leap", "Quiet fury"); empty = untitled. */
  title: z.string().default(""),
  /** The study brief — what to explore (kept so a study can be re-rolled/refined). */
  prompt: z.string().default(""),
  /** Freeform curator notes ("canonical from ch.3 on", "ears too long here"). */
  notes: z.string().default(""),
  /** Canonical flag — the starred study is THE reference for its category. */
  starred: z.boolean().default(false),
  /** Style pack used to generate it (provenance + default for regeneration). */
  styleId: z.string().default(""),
  /** The selected/displayed image (a hash from `variants`). */
  resultHash: z.string().length(64).optional(),
  /** Generation history (most-recent last, capped — same policy as comic frames). */
  variants: z.array(ComicVariantSchema).default([]),
  createdAt: isoString.optional(),
  updatedAt: isoString.optional(),
});
export type CharacterStudy = z.infer<typeof CharacterStudySchema>;

/** A study's current image: the selected result, else its newest variant. */
export function studyImageHash(study: CharacterStudy): string | undefined {
  return study.resultHash ?? study.variants.at(-1)?.hash;
}

/**
 * Identity refs a study feeds. Higher than the comic's `MAX_REFS_PER_CHARACTER`
 * (2): a study renders exactly one character, so there is no cast competing for
 * the model's reference budget — spend it on locking this identity harder.
 */
export const MAX_STUDY_CHARACTER_REFS = 4;

/** Text ban appended to every study's negative — reference sheets must be clean
 *  artwork with no labels, regardless of which style pack is active. */
export const STUDY_BASE_NEGATIVE =
  "text, words, letters, typography, watermark, signature, logo, frame border";

/** A study's negative prompt: the style pack's (medium constraints) + the text ban. */
export function studyNegative(packNegative?: string): string {
  const pack = packNegative?.trim();
  return pack ? `${pack}, ${STUDY_BASE_NEGATIVE}` : STUDY_BASE_NEGATIVE;
}

/** The character fields a study generation reads — structural, so the compiler
 *  works with either a full `LibraryCharacter` or a plain subset. */
export interface StudyCharacterIdentity {
  name: string;
  description: string;
  palette: string[];
  refHashes: string[];
}

/** The style-pack fields a study generation reads. */
export interface StudyStyleSource {
  theme: string;
  negative: string;
  anchors: ComicReference[];
  loras: ComicLora[];
}

/**
 * Compose one study's generation prompt. Mirrors `composeFramePrompt`'s
 * discipline — subject first, directives trailing, deterministic and previewable:
 *
 *   {prompt}                        — the study brief leads
 *   {category directive}            — frames it as a pose sheet / turnaround / …
 *   Character: {name} — {desc}      — the text identity lock
 *   {palette directive}             — the character's palette (identity colors)
 *   Style: {pack theme}             — the look, when a style pack is applied
 *   {reference directive}           — compose-mode: refs lock identity, prompt owns layout
 */
export function composeStudyPrompt(
  category: StudyCategory,
  prompt: string,
  character: StudyCharacterIdentity,
  pack?: Pick<StudyStyleSource, "theme">,
  hasReferences = true,
): string {
  const name = character.name.trim();
  const desc = character.description.trim();
  const identity = desc ? (name ? `Character: ${name} — ${desc}` : `Character: ${desc}`) : name ? `Character: ${name}.` : "";
  const parts = [
    prompt.trim(),
    STUDY_CATEGORIES[category].directive,
    identity,
    paletteDirective(character.palette),
    pack?.theme.trim() ? `Style: ${pack.theme.trim()}` : "",
    hasReferences ? referenceDirective("compose") : "",
  ];
  return parts.filter(Boolean).join("\n\n");
}

/**
 * The ordered, weighted reference set for a study: the character's identity refs
 * first (capped, most-distinctive-first — the whole point of the studio), then the
 * style pack's anchors. Deduped by hash (first wins), so on reference-capped
 * models the identity outranks the look — same truncation policy as comic frames.
 */
export function studyReferences(
  character: StudyCharacterIdentity,
  pack?: Pick<StudyStyleSource, "anchors">,
): ComicReference[] {
  const byHash = new Map<string, ComicReference>();
  for (const ref of [
    ...character.refHashes
      .slice(0, MAX_STUDY_CHARACTER_REFS)
      .map((hash) => ({ hash, weight: DEFAULT_REFERENCE_WEIGHT })),
    ...(pack?.anchors ?? []),
  ]) {
    if (!byHash.has(ref.hash)) byHash.set(ref.hash, ref);
  }
  return [...byHash.values()];
}

/**
 * The LoRAs a study applies: the character's subject LoRA FIRST (identity is the
 * subject of a study — the inverse of a comic frame, where the shared style is
 * the stable base), then the style pack's. Deduped by path; blank paths dropped.
 */
export function studyLoras(
  characterLora: ComicLora | undefined,
  pack?: Pick<StudyStyleSource, "loras">,
): ComicLora[] {
  const byPath = new Map<string, ComicLora>();
  for (const lora of [...(characterLora ? [characterLora] : []), ...(pack?.loras ?? [])]) {
    if (lora.path.trim() && !byPath.has(lora.path)) byPath.set(lora.path, lora);
  }
  return [...byPath.values()];
}

/** Compiled node id for a study generation slot ("v0"…"v3") or refine ("edit").
 *  Prefixed so WS progress events route back to the study on the client. */
export const studyNodeId = (studyId: string, slot: number | "edit"): string =>
  `study-${studyId}-${slot === "edit" ? "edit" : `v${slot}`}`;

/** Inverse of `studyNodeId` — maps a compiled node id back to its study. */
export function studyIdFromNodeId(nodeId: string): string | undefined {
  const m = /^study-(.+)-(?:v\d+|edit)$/.exec(nodeId);
  return m?.[1];
}

/** How many variants one generate call may request (bounded spend per click). */
export const MAX_STUDY_BATCH = 4;

/** Everything a study generation run needs — resolved by the server route,
 *  compiled here so what runs is exactly what the schema describes. */
export interface StudyRunSpec {
  characterId: string;
  studyId: string;
  category: StudyCategory;
  prompt: string;
  character: StudyCharacterIdentity;
  pack?: StudyStyleSource;
  /** The character's ready subject LoRA, when it has one. */
  lora?: ComicLora;
  modelId: string;
  /** Variant count for this run (1..MAX_STUDY_BATCH); node i runs seed+i. */
  count: number;
  seed: number;
}

/**
 * Lower one study run to a runnable GraphDocument: `count` generation nodes (no
 * export — bytes land in the asset store and hashes are read back from the run
 * result), each with the same composed prompt and consecutive seeds so one click
 * explores several takes of the same brief.
 */
export function compileStudyRun(spec: StudyRunSpec): GraphDocument {
  const meta = STUDY_CATEGORIES[spec.category];
  const references = studyReferences(spec.character, spec.pack);
  const loras = studyLoras(spec.lora, spec.pack).map((l) => ({ path: l.path, scale: l.scale }));
  const prompt = composeStudyPrompt(
    spec.category,
    spec.prompt,
    spec.character,
    spec.pack,
    references.length > 0,
  );

  return GraphDocumentSchema.parse({
    version: 1,
    id: `study-${spec.characterId}-${spec.studyId}`,
    name: `${spec.character.name || "Character"} · ${meta.label} study`,
    nodes: Array.from({ length: spec.count }, (_, i) => ({
      id: studyNodeId(spec.studyId, i),
      type: "generate.text-to-image",
      position: { x: i * 360, y: 0 },
      params: {
        model: spec.modelId,
        prompt,
        negativePrompt: studyNegative(spec.pack?.negative),
        width: meta.width,
        height: meta.height,
        seed: spec.seed + i,
        ...(references.length ? { references } : {}),
        ...(loras.length ? { loras } : {}),
      },
      title: `${meta.label} v${i + 1}`,
    })),
    edges: [],
  });
}

/** A refine pass over one study image: instruction-driven image-to-image. */
export interface StudyRefineSpec {
  characterId: string;
  studyId: string;
  category: StudyCategory;
  /** The variant to refine (must already be in the asset store). */
  baseHash: string;
  instruction: string;
  mode: EditMode;
  character: StudyCharacterIdentity;
  pack?: StudyStyleSource;
  lora?: ComicLora;
  modelId: string;
  seed: number;
}

/**
 * Lower a study refine to a single-node edit graph: the base image leads the
 * reference set at full weight (the edit model builds on it), followed by the
 * character's identity refs + style anchors so likeness and look hold through
 * the edit. Prompt/mode semantics are exactly the comic's `composeEditPrompt`.
 */
export function compileStudyRefine(spec: StudyRefineSpec): GraphDocument {
  const meta = STUDY_CATEGORIES[spec.category];
  const byHash = new Map<string, ComicReference>();
  for (const ref of [
    { hash: spec.baseHash, weight: DEFAULT_REFERENCE_WEIGHT },
    ...studyReferences(spec.character, spec.pack),
  ]) {
    if (!byHash.has(ref.hash)) byHash.set(ref.hash, ref);
  }
  const references = [...byHash.values()];
  const loras = studyLoras(spec.lora, spec.pack).map((l) => ({ path: l.path, scale: l.scale }));

  return GraphDocumentSchema.parse({
    version: 1,
    id: `study-${spec.characterId}-${spec.studyId}-refine`,
    name: `${spec.character.name || "Character"} · refine`,
    nodes: [
      {
        id: studyNodeId(spec.studyId, "edit"),
        type: "generate.text-to-image",
        position: { x: 0, y: 0 },
        params: {
          model: spec.modelId,
          prompt: composeEditPrompt(spec.instruction, spec.mode),
          negativePrompt: studyNegative(spec.pack?.negative),
          width: meta.width,
          height: meta.height,
          seed: spec.seed,
          references,
          ...(loras.length ? { loras } : {}),
        },
        title: "Refine study",
      },
    ],
    edges: [],
  });
}

/**
 * Merge a character's studies on whole-record upsert — the studio's mirror of the
 * comic store's variant protection. Generation outputs are **server-authoritative**:
 * a client PUT carries whatever studies snapshot it had, so a variant (or a whole
 * study) that landed server-side mid-flight must survive the write.
 *
 *   • Studies in both: incoming metadata wins (it's the user's edit), variants are
 *     union-merged, and `resultHash` falls back sanely if the incoming selection
 *     doesn't exist in the merged history.
 *   • Studies only in `existing` are KEPT — deletion happens exclusively through
 *     the DELETE route, so a stale snapshot can never silently drop a study.
 *   • Studies only in `incoming` are appended (client-created, awaiting first run).
 */
export function mergeStudies(
  existing: readonly CharacterStudy[],
  incoming: readonly CharacterStudy[],
): CharacterStudy[] {
  const incomingById = new Map(incoming.map((s) => [s.id, s]));
  const merged: CharacterStudy[] = [];
  for (const cur of existing) {
    const inc = incomingById.get(cur.id);
    if (!inc) {
      merged.push(cur);
      continue;
    }
    incomingById.delete(cur.id);
    const variants = unionVariants(cur.variants, inc.variants);
    merged.push({ ...inc, variants, resultHash: reconcileResult(inc, cur, variants) });
  }
  for (const inc of incoming) {
    if (incomingById.has(inc.id)) merged.push(inc);
  }
  return merged;
}

/** Pick the selection surviving a merge: incoming's if still valid, else the
 *  existing one, else the newest merged variant. */
function reconcileResult(
  incoming: CharacterStudy,
  existing: CharacterStudy,
  variants: ComicVariant[],
): string | undefined {
  const valid = new Set(variants.map((v) => v.hash));
  if (incoming.resultHash && valid.has(incoming.resultHash)) return incoming.resultHash;
  if (existing.resultHash && valid.has(existing.resultHash)) return existing.resultHash;
  return variants.at(-1)?.hash;
}
