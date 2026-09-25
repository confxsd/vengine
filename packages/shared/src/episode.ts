import { z } from "zod";

/**
 * **Episode planning vocabulary** — the closed vocabularies and the plan schema
 * for the planned-episode feature (docs/EPISODE_STUDIO.md §3–§4). Lives in its
 * own leaf module (imports only zod) because BOTH `comic.ts` and `director.ts`
 * need these values at schema-definition time: comic re-exports them
 * (`export * from "./episode.js"`) and the director contract builds on them
 * without creating a comic ⇄ director import cycle.
 *
 * Everything here is optional/defaulted on the documents that carry it — zero
 * migration for pre-plan projects.
 */

/** Which proven 4-beat form this episode follows. */
export const EPISODE_STRUCTURES = ["kishotenketsu", "detonate", "continuous", "framed-tale"] as const;
export type EpisodeStructure = (typeof EPISODE_STRUCTURES)[number];

/** The role a panel plays in the structure (vocabulary is closed; slot maps are data). */
export const FRAME_ROLES = ["establish", "develop", "escalate", "turn", "settle", "payoff"] as const;
export type FrameRole = (typeof FRAME_ROLES)[number];

/** How this panel connects to the previous one (McCloud's six transitions). */
export const GUTTER_TYPES = ["moment", "action", "subject", "scene", "aspect", "nonsequitur"] as const;
export type GutterType = (typeof GUTTER_TYPES)[number];

/** Structure → the four slot roles (frames beyond 4 repeat `develop`/`escalate`). */
export const STRUCTURE_ROLES: Record<EpisodeStructure, FrameRole[]> = {
  kishotenketsu: ["establish", "develop", "turn", "settle"],
  detonate: ["establish", "develop", "escalate", "payoff"],
  continuous: ["establish", "develop", "turn", "settle"],
  "framed-tale": ["establish", "develop", "turn", "settle"],
};

/** Human labels for the structures (UI chips + prompts). */
export const EPISODE_STRUCTURE_LABELS: Record<EpisodeStructure, string> = {
  kishotenketsu: "Kishōtenketsu — twist lands P3",
  detonate: "Detonate — escalate to a P4 payoff",
  continuous: "Continuous moment — four angles",
  "framed-tale": "Framed tale — nested storylines",
};

/**
 * The role of the frame at 0-based position `i` under `structure`: the slot map
 * for the first four frames, then `develop`/`escalate` alternating beyond it
 * (the documented extension for 5+ frame episodes — the plan *describes* the
 * structure, it never resizes the episode).
 */
export function structureRoleAt(structure: EpisodeStructure, i: number): FrameRole {
  const roles = STRUCTURE_ROLES[structure];
  if (i < roles.length) return roles[i]!;
  return (i - roles.length) % 2 === 0 ? "develop" : "escalate";
}

/**
 * The episode's creative configuration — the "one unified vision" every frame
 * prompt receives (see `composeFramePrompt`). Sampled from the series premise
 * by the draft model at parse time (a greenlight pass in a later phase).
 * `archetype` is *direction* (light, palette, camera attitude), never a new
 * medium — the "no invented art style" rule still holds. `token` is the
 * serialization element passed forward to the next episode (metadata for now).
 * All fields defaulted so any parse (or old project) is valid.
 */
export const EpisodePlanSchema = z.object({
  structure: z.enum(EPISODE_STRUCTURES).default("kishotenketsu"),
  /** This episode's art direction phrase. */
  archetype: z.string().default(""),
  /** The creative experiment / angle. */
  strategy: z.string().default(""),
  /** Thematic through-line from the series premise. */
  theme: z.string().default(""),
  /** The recurring central image (must appear/recall ≥2 times before its payoff). */
  motif: z.string().default(""),
  /** Element passed forward to the next episode. */
  token: z.string().default(""),
});
export type EpisodePlan = z.infer<typeof EpisodePlanSchema>;
