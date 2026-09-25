import { z } from "zod";
// The plan vocabulary comes from the leaf `episode.ts` (re-exported by comic.ts):
// importing the VALUES from comic.ts would create a comic ⇄ director runtime
// cycle (comic imports DirectorMessageSchema from this file).
import {
  EPISODE_STRUCTURES,
  EpisodePlanSchema,
  FRAME_ROLES,
  GUTTER_TYPES,
  structureRoleAt,
  type EpisodePlan,
} from "./episode.js";
import type { ComicCharacter, ComicFrame, ComicProject } from "./comic.js";
import type { Library, LibraryCharacter } from "./library.js";
import type { Series } from "./scene.js";

/**
 * **Director chat** — the revision loop after a draft is imported. The author talks
 * to their story like a director ("frame 3's Bruce should read wounded, not
 * contemptuous"; "the whole episode is melancholic — fix the moods"), and a text
 * model both *discusses* the theme/subtext and emits a structured, typed change-set
 * (`DirectorChange[]`) that the server applies to the right entities. This replaces
 * hand-fixing extraction noise one field at a time.
 *
 * The system prompt driving the model lives server-side in `apps/server/src/director.ts`;
 * this module is the shared contract (schemas both sides validate against) plus the
 * pure, deterministic `applyDirectorChanges` applier — mirroring `draft.ts`.
 */

/** Max characters accepted in one director message (guards token cost / abuse). */
export const DIRECTOR_MAX_INPUT = 8_000;

/** Chat history retained on the project document (most-recent last). */
export const DIRECTOR_MAX_HISTORY = 200;

/** How many prior messages are replayed to the model as conversation context. */
export const DIRECTOR_CONTEXT_MESSAGES = 20;

/** Frame fields the model may clear explicitly: `null` clears, omission keeps. */
const clearableString = z.string().nullable().optional();

const index = z.number().int().nonnegative();

/** One typed edit the director decided on. `op` discriminates the union. */
export const DirectorChangeSchema = z.discriminatedUnion("op", [
  /** Episode-level fields: story, its prevailing mood, settings, style, palette. */
  z.object({
    op: z.literal("updateProject"),
    name: z.string().optional(),
    story: z.string().optional(),
    storyMood: clearableString,
    settings: z.string().optional(),
    /** Rewrites `style.theme` (the visual style anchor). */
    styleTheme: z.string().optional(),
    /** Rewrites `style.palette` (the color lock). */
    palette: z.array(z.string()).optional(),
  }),
  /**
   * Edit the episode's creative plan. A `structure` change remaps every frame's
   * role to the new slot map (`structureRoleAt`) and logs it; the text fields
   * are clearable via null (structure null resets to the default form).
   */
  z.object({
    op: z.literal("updatePlan"),
    structure: z.enum(EPISODE_STRUCTURES).nullable().optional(),
    archetype: clearableString,
    strategy: clearableString,
    theme: clearableString,
    motif: clearableString,
    token: clearableString,
  }),
  /** Edit one frame by 0-based position. Omitted fields are kept; `null` clears. */
  z.object({
    op: z.literal("updateFrame"),
    frameIndex: index,
    prompt: z.string().optional(),
    script: clearableString,
    camera: clearableString,
    mood: clearableString,
    /** Storyline label; null clears back to the episode's main storyline. */
    thread: clearableString,
    /** Frame palette accents; null clears (inherits the project palette), [] drops the lock. */
    palette: z.array(z.string()).nullable().optional(),
    /** null → whole cast (clears the subset); array → exactly those characters. */
    characterNames: z.array(z.string()).nullable().optional(),
    /** Link this frame as a continuation of the frame at that 0-based index. */
    continuesFrameIndex: index.nullable().optional(),
    /** This panel's role in the structure; null clears (no role flavor). */
    role: z.enum(FRAME_ROLES).nullable().optional(),
    /** The typed gutter into this panel; null clears. */
    gutter: z.enum(GUTTER_TYPES).nullable().optional(),
    /** Mirror the composition of the frame at that 0-based index (the bookend payout). */
    echoFrameIndex: index.nullable().optional(),
  }),
  /** Insert a new frame after `afterIndex` (-1-equivalent not needed: 0 = first). */
  z.object({
    op: z.literal("addFrame"),
    afterIndex: index,
    prompt: z.string().default(""),
    script: z.string().optional(),
    mood: z.string().optional(),
    thread: z.string().optional(),
    palette: z.array(z.string()).optional(),
    characterNames: z.array(z.string()).default([]),
  }),
  z.object({ op: z.literal("deleteFrame"), frameIndex: index }),
  /** Move a frame (0-based positions, evaluated before any add/delete in the same set). */
  z.object({ op: z.literal("moveFrame"), from: index, to: index }),
  /**
   * Create/update a character in the shared library (matched by name or alias,
   * case-insensitive). New characters are also added to this project's cast and,
   * when the episode belongs to a universe, to the series cast.
   */
  z.object({
    op: z.literal("upsertCharacter"),
    name: z.string().min(1),
    aliases: z.array(z.string()).optional(),
    /** Identity/defining-features text; null clears. */
    description: clearableString,
    palette: z.array(z.string()).optional(),
  }),
  /**
   * Pin a character to one of their named life stages (teen / young / mature…) for
   * THIS episode. The era is found (or created) on the canon library character; the
   * era's identity refs replace the cast entry's, and its label rides the cast for
   * display. An optional `description` seeds/updates the era's defining features.
   */
  z.object({
    op: z.literal("setCharacterEra"),
    name: z.string().min(1),
    /** Era label, e.g. "teen", "young", "mature" (matched case-insensitively). */
    era: z.string().min(1),
    /** Era-defining features (age-bearing look); updates the canon era when given. */
    description: z.string().optional(),
  }),
  /** Update the universe (series) this episode belongs to. Ignored when standalone. */
  z.object({
    op: z.literal("updateSeries"),
    concept: z.string().optional(),
    description: z.string().optional(),
  }),
]);
export type DirectorChange = z.infer<typeof DirectorChangeSchema>;

/** One turn of the conversation, persisted on the project (`director` field). */
export const DirectorMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  text: z.string().default(""),
  /** The structured changes this turn carried (empty for pure discussion). */
  changes: z.array(DirectorChangeSchema).default([]),
  /** Human-readable summary of what was (to be) applied, one line per change. */
  log: z.array(z.string()).default([]),
  at: z.string(),
});
export type DirectorMessage = z.infer<typeof DirectorMessageSchema>;

/** The model's reply shape: the discussion plus the changes it decided on. */
export const DirectorReplySchema = z.object({
  reply: z.string().default(""),
  changes: z.array(DirectorChangeSchema).default([]),
});
export type DirectorReply = z.infer<typeof DirectorReplySchema>;

export interface DirectorConfig {
  /** True when a text model is registered AND its API key is set server-side. */
  available: boolean;
  model: string | null;
}

export interface DirectorHistory {
  messages: DirectorMessage[];
}

/** What one director turn produced: the discussion, the applied change log, and
 *  the refreshed project (the client adopts it wholesale). */
export interface DirectorTurnResult {
  reply: string;
  log: string[];
  project: ComicProject;
}

// ---------------------------------------------------------------------------
// Cast name matching (shared by the director applier and the draft apply path)
// ---------------------------------------------------------------------------

/**
 * Build a lowercase name/alias → cast-id index (first name wins, mirroring the
 * draft apply path in the client and `ingest-story`).
 */
export function castIndex(cast: readonly ComicCharacter[]): Map<string, string> {
  const byName = new Map<string, string>();
  for (const c of cast) {
    for (const n of [c.name, ...c.aliases]) {
      const key = n.trim().toLowerCase();
      if (key && !byName.has(key)) byName.set(key, c.id);
    }
  }
  return byName;
}

/** Map character NAMES onto cast ids via name or alias, preserving the input order
 *  (so the order the director lists characters in is the order they're recorded).
 *  Unmatched names dropped; duplicates collapsed. */
export function matchCharacterIds(
  cast: readonly ComicCharacter[],
  names: readonly string[],
): string[] {
  const byName = castIndex(cast);
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const n of names) {
    const id = byName.get(n.trim().toLowerCase());
    if (id && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

// ---------------------------------------------------------------------------
// The applier
// ---------------------------------------------------------------------------

export interface DirectorApplyResult {
  project: ComicProject;
  library: Library;
  series: Series | null;
  /** Library characters touched this turn (to persist via `upsertCharacter`). */
  dirtyCharacters: LibraryCharacter[];
  log: string[];
  /** Changes skipped as invalid (out-of-range index, unknown character…) — surfaced
   *  so the chat can tell the author instead of silently dropping their note. */
  skipped: string[];
}

const defaultMakeId = (): string => {
  const uuid = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto?.randomUUID?.();
  return (uuid ?? `${Date.now()}-${Math.random()}`).slice(0, 8);
};

const norm = (s: string) => s.trim().toLowerCase();

/**
 * Pure, deterministic application of a director change-set. Never throws on bad
 * input: invalid changes are skipped and reported in `skipped`. The caller persists
 * `project` (whole-document save), each `dirtyCharacters` entry, and `series` when
 * it changed (dirty series are signaled by returning a series object + a log entry;
 * compare by reference or check the log).
 */
export function applyDirectorChanges(
  project: ComicProject,
  library: Library,
  series: Series | null,
  changes: readonly DirectorChange[],
  makeId: () => string = defaultMakeId,
): DirectorApplyResult {
  let next: ComicProject = { ...project, style: { ...project.style } };
  let nextLibrary: Library = library;
  const dirtyCharacters: LibraryCharacter[] = [];
  const log: string[] = [];
  const skipped: string[] = [];
  let seriesDirty = false;

  const frameNo = (i: number) => `frame ${i + 1}`;

  /** Resolve a director-named character to its canon library entry: direct
   *  name/alias match, or through the project cast (whose entry may carry extra
   *  aliases, or an explicit `libraryId` naming the canon character). */
  const resolveCanon = (p: ComicProject, name: string): LibraryCharacter | undefined => {
    const castHit = p.cast.find(
      (c) => norm(c.name) === norm(name) || c.aliases.some((a) => norm(a) === norm(name)),
    );
    const castNames = castHit
      ? [castHit.name, ...castHit.aliases].map(norm).filter(Boolean)
      : [];
    return nextLibrary.characters.find(
      (c) =>
        norm(c.name) === norm(name) ||
        c.aliases.some((a) => norm(a) === norm(name)) ||
        (castHit?.libraryId !== undefined && c.id === castHit.libraryId) ||
        castNames.includes(norm(c.name)) ||
        c.aliases.some((a) => castNames.includes(norm(a))),
    );
  };

  /** Mirror a library character into `next`'s cast (update the matching entry, or
   *  add a linked one) and into `nextLibrary`. Returns the mutated library copy. */
  const adoptIntoCast = (p: ComicProject, char: LibraryCharacter, extra?: Partial<ComicCharacter>): { project: ComicProject; library: Library } => {
    const castEntry = p.cast.find(
      (c) => c.libraryId === char.id ||
        norm(c.name) === norm(char.name) ||
        c.aliases.some((a) => norm(a) === norm(char.name)),
    );
    const project =
      castEntry === undefined
        ? {
            ...p,
            cast: [
              ...p.cast,
              {
                id: char.id,
                name: char.name,
                aliases: char.aliases,
                refHashes: char.refHashes,
                libraryId: char.id,
                ...extra,
              } satisfies ComicCharacter,
            ],
          }
        : {
            ...p,
            cast: p.cast.map((c) =>
              c.id === castEntry.id
                ? { ...c, name: char.name, aliases: char.aliases, libraryId: char.id, ...extra }
                : c,
            ),
          };
    const lib = {
      ...nextLibrary,
      characters: nextLibrary.characters.some((c) => c.id === char.id)
        ? nextLibrary.characters.map((c) => (c.id === char.id ? char : c))
        : [...nextLibrary.characters, char],
    };
    nextLibrary = lib;
    return { project, library: lib };
  };

  for (const change of changes) {
    switch (change.op) {
      case "updateProject": {
        const parts: string[] = [];
        if (change.name !== undefined && change.name.trim()) {
          next = { ...next, name: change.name.trim() };
          parts.push("title");
        }
        if (change.story !== undefined) {
          next = { ...next, story: change.story };
          parts.push("story");
        }
        if (change.storyMood !== undefined) {
          next = { ...next, storyMood: change.storyMood ?? undefined };
          parts.push(change.storyMood ? `story mood → “${change.storyMood}”` : "story mood cleared");
        }
        if (change.settings !== undefined) {
          next = { ...next, settings: change.settings };
          parts.push("settings");
        }
        if (change.styleTheme !== undefined) {
          next = { ...next, style: { ...next.style, theme: change.styleTheme } };
          parts.push("style theme");
        }
        if (change.palette !== undefined) {
          next = { ...next, style: { ...next.style, palette: change.palette } };
          parts.push("palette");
        }
        if (parts.length) log.push(`episode: ${parts.join(" · ")}`);
        break;
      }
      case "updatePlan": {
        const planFields = [
          "structure",
          "archetype",
          "strategy",
          "theme",
          "motif",
          "token",
        ] as const;
        if (!planFields.some((k) => change[k] !== undefined)) break; // nothing to do
        const parts: string[] = [];
        let plan: EpisodePlan = next.plan ?? EpisodePlanSchema.parse({});
        if (change.structure !== undefined) {
          // null resets to the default form (an enum with a default has no "unset").
          const structure = change.structure ?? "kishotenketsu";
          const remap = structure !== plan.structure;
          plan = { ...plan, structure };
          parts.push(
            change.structure
              ? `structure → ${structure}${remap ? " (frame roles remapped)" : ""}`
              : `structure reset to ${structure}`,
          );
          if (remap) {
            // The slots' meaning changes with the form: remap every frame's role
            // to the new structure's map so roles and plan never disagree.
            next = {
              ...next,
              frames: next.frames.map((f, i) => ({ ...f, role: structureRoleAt(structure, i) })),
            };
          }
        }
        for (const key of ["archetype", "strategy", "theme", "motif", "token"] as const) {
          const v = change[key];
          if (v !== undefined) {
            plan = { ...plan, [key]: v ?? "" };
            parts.push(v ? `${key} → “${v}”` : `${key} cleared`);
          }
        }
        next = { ...next, plan };
        log.push(`plan: ${parts.join(" · ")}`);
        break;
      }
      case "updateFrame": {
        const i = change.frameIndex;
        const frame = next.frames[i];
        if (!frame) {
          skipped.push(`${frameNo(i)} doesn't exist (episode has ${next.frames.length})`);
          break;
        }
        const parts: string[] = [];
        let f: ComicFrame = { ...frame };
        if (change.prompt !== undefined) {
          f = { ...f, prompt: change.prompt };
          parts.push("prompt rewritten");
        }
        if (change.script !== undefined) {
          f = { ...f, script: change.script ?? undefined };
          parts.push(change.script ? "script updated" : "script cleared");
        }
        if (change.camera !== undefined) {
          f = { ...f, camera: change.camera ?? undefined };
          parts.push(change.camera ? `camera → ${change.camera}` : "camera cleared");
        }
        if (change.mood !== undefined) {
          f = { ...f, mood: change.mood ?? undefined };
          parts.push(change.mood ? `mood → “${change.mood}”` : "mood cleared");
        }
        if (change.thread !== undefined) {
          f = { ...f, thread: change.thread ?? undefined };
          parts.push(change.thread ? `storyline → “${change.thread}”` : "storyline cleared");
        }
        if (change.palette !== undefined) {
          f = { ...f, palette: change.palette ?? undefined };
          parts.push(
            change.palette
              ? `palette → ${change.palette.join(", ")}`
              : "palette cleared (inherits episode)",
          );
        }
        if (change.characterNames !== undefined) {
          if (change.characterNames === null) {
            f = { ...f, characterIds: undefined };
            parts.push("cast → whole cast");
          } else {
            const ids = matchCharacterIds(next.cast, change.characterNames);
            if (change.characterNames.length && !ids.length) {
              skipped.push(
                `${frameNo(i)}: no cast member matches ${change.characterNames.join(", ")}`,
              );
            } else {
              f = { ...f, characterIds: ids };
              parts.push("cast updated");
            }
          }
        }
        if (change.continuesFrameIndex !== undefined) {
          const target = next.frames[change.continuesFrameIndex ?? -1];
          if (change.continuesFrameIndex === null) {
            f = { ...f, continuesFrameId: undefined };
            parts.push("continuity link cleared");
          } else if (target && target.id !== f.id) {
            f = { ...f, continuesFrameId: target.id };
            parts.push(`continues ${frameNo(change.continuesFrameIndex)}`);
          } else {
            skipped.push(`${frameNo(i)}: invalid continuation target`);
          }
        }
        if (change.role !== undefined) {
          f = { ...f, role: change.role ?? undefined };
          parts.push(change.role ? `role → ${change.role}` : "role cleared");
        }
        if (change.gutter !== undefined) {
          f = { ...f, gutter: change.gutter ?? undefined };
          parts.push(change.gutter ? `gutter → ${change.gutter}` : "gutter cleared");
        }
        if (change.echoFrameIndex !== undefined) {
          const target = next.frames[change.echoFrameIndex ?? -1];
          if (change.echoFrameIndex === null) {
            f = { ...f, echoFrameId: undefined };
            parts.push("echo cleared");
          } else if (target && target.id !== f.id) {
            f = { ...f, echoFrameId: target.id };
            parts.push(`echoes ${frameNo(change.echoFrameIndex)}`);
          } else {
            skipped.push(`${frameNo(i)}: invalid echo target`);
          }
        }
        if (parts.length) {
          next = { ...next, frames: next.frames.map((x) => (x.id === f.id ? f : x)) };
          log.push(`${frameNo(i)}: ${parts.join(" · ")}`);
        }
        break;
      }
      case "addFrame": {
        const at = Math.min(change.afterIndex + 1, next.frames.length);
        const ids = matchCharacterIds(next.cast, change.characterNames);
        const frame: ComicFrame = {
          id: makeId(),
          prompt: change.prompt,
          variants: [],
          refHashes: [],
          ...(change.script?.trim() ? { script: change.script } : {}),
          ...(change.mood?.trim() ? { mood: change.mood } : {}),
          ...(change.thread?.trim() ? { thread: change.thread } : {}),
          ...(change.palette?.length ? { palette: change.palette } : {}),
          ...(ids.length ? { characterIds: ids } : {}),
        };
        next = {
          ...next,
          frames: [...next.frames.slice(0, at), frame, ...next.frames.slice(at)],
        };
        log.push(`added ${frameNo(at)}${change.prompt ? "" : " (empty)"}`);
        break;
      }
      case "deleteFrame": {
        const i = change.frameIndex;
        if (!next.frames[i]) {
          skipped.push(`${frameNo(i)} doesn't exist`);
          break;
        }
        const removedId = next.frames[i].id;
        next = {
          ...next,
          frames: next.frames
            .filter((_, x) => x !== i)
            // Frames continuing (or echoing) the removed frame keep rendering —
            // just drop the link (each independently: a frame doing both loses both).
            .map((f) => {
              const dropContinues = f.continuesFrameId === removedId;
              const dropEcho = f.echoFrameId === removedId;
              return dropContinues || dropEcho
                ? {
                    ...f,
                    ...(dropContinues ? { continuesFrameId: undefined } : {}),
                    ...(dropEcho ? { echoFrameId: undefined } : {}),
                  }
                : f;
            }),
        };
        log.push(`deleted ${frameNo(i)}`);
        break;
      }
      case "moveFrame": {
        const { from, to } = change;
        if (!next.frames[from] || !next.frames[to] || from === to) {
          skipped.push(`move ${from}→${to} is invalid`);
          break;
        }
        const frames = [...next.frames];
        const [moved] = frames.splice(from, 1);
        if (!moved) break;
        frames.splice(to, 0, moved);
        next = { ...next, frames };
        log.push(`moved ${frameNo(from)} → position ${to + 1}`);
        break;
      }
      case "upsertCharacter": {
        const name = change.name.trim();
        const existing = resolveCanon(next, name);
        let char: LibraryCharacter;
        if (existing) {
          char = { ...existing, name: existing.name || name };
          if (change.aliases !== undefined) char = { ...char, aliases: change.aliases };
          if (change.description !== undefined)
            char = { ...char, description: change.description ?? "" };
          if (change.palette !== undefined) char = { ...char, palette: change.palette };
        } else {
          char = {
            id: makeId(),
            name,
            aliases: change.aliases ?? [],
            refHashes: [],
            description: change.description ?? "",
            palette: change.palette ?? [],
            eras: [],
            studies: [],
            tags: [],
          };
        }
        dirtyCharacters.push(char);
        next = adoptIntoCast(next, char).project;

        // New recurring characters join the universe's canon cast.
        if (series && !series.castIds.includes(char.id)) {
          series = { ...series, castIds: [...series.castIds, char.id] };
          seriesDirty = true;
        }
        log.push(
          `${existing ? "updated" : "created"} character “${char.name}”${
            change.description ? " (description)" : ""
          }`,
        );
        break;
      }
      case "setCharacterEra": {
        const name = change.name.trim();
        const existing = resolveCanon(next, name);
        if (!existing) {
          skipped.push(`no character “${name}” to set an era on`);
          break;
        }
        const label = change.era.trim();
        // Find or create the era on the canon character (label match, case-insensitive).
        let era = existing.eras.find((e) => norm(e.label) === norm(label));
        if (!era) {
          era = { id: makeId(), label, description: "", refHashes: [], palette: [] };
        }
        if (change.description !== undefined && change.description.trim()) {
          era = { ...era, description: change.description.trim() };
        }
        const char: LibraryCharacter = {
          ...existing,
          eras: existing.eras.some((e) => e.id === era!.id)
            ? existing.eras.map((e) => (e.id === era!.id ? era! : e))
            : [...existing.eras, era],
        };
        dirtyCharacters.push(char);
        // The cast entry carries the era's label + (when the era has any) its
        // identity refs — so generation uses THIS life stage's look, engine unchanged.
        next = adoptIntoCast(next, char, {
          eraLabel: era.label,
          ...(era.refHashes.length ? { refHashes: era.refHashes } : {}),
        }).project;
        log.push(`“${char.name}” pinned to era “${era.label}” for this episode`);
        break;
      }
      case "updateSeries": {
        if (!series) {
          skipped.push("this episode doesn't belong to a universe");
          break;
        }
        let touched = false;
        if (change.concept !== undefined) {
          series = { ...series, concept: change.concept };
          touched = true;
        }
        if (change.description !== undefined) {
          series = { ...series, description: change.description };
          touched = true;
        }
        if (touched) {
          seriesDirty = true;
          log.push("universe concept updated");
        }
        break;
      }
    }
  }

  if (seriesDirty && series) {
    nextLibrary = {
      ...nextLibrary,
      series: nextLibrary.series.map((s) => (s.id === series.id ? series : s)),
    };
  }

  return { project: next, library: nextLibrary, series, dirtyCharacters, log, skipped };
}
