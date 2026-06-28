import { z } from "zod";
import type { ComicFrame, ComicProject } from "./comic.js";

/**
 * AI text-assist configuration — the single source of truth shared by the client
 * (which fields show a button, which modes each offers) and the server (which
 * validates requests). The seeded system prompts that drive the model live
 * server-side in `apps/server/src/assist.ts`, keyed by these same enums.
 *
 * Expand the feature by adding a field to `ASSIST_FIELDS` (+ its metadata + a
 * server prompt) or a mode to `ASSIST_MODES` (+ its metadata + a server prompt).
 */

/** The text fields a user can ask the AI to improve. */
export const ASSIST_FIELDS = [
  "story",
  "settings",
  "styleTheme",
  "framePrompt",
  "promptTemplate",
  "negativePrompt",
] as const;
export type AssistField = (typeof ASSIST_FIELDS)[number];

/**
 * The kinds of revision the AI can perform, ordered conservative → heavy. The
 * default for every field is the light-touch `polish`; `enrich` is opt-in and
 * still guard-railed (no new artistic direction). See the server prompts.
 */
export const ASSIST_MODES = ["polish", "grammar", "enrich", "shorten"] as const;
export type AssistMode = (typeof ASSIST_MODES)[number];

export interface AssistModeMeta {
  id: AssistMode;
  /** Short label for the button/menu. */
  label: string;
  /** One-line description shown in the menu / tooltip. */
  hint: string;
}

export const ASSIST_MODE_META: Record<AssistMode, AssistModeMeta> = {
  polish: {
    id: "polish",
    label: "Polish",
    hint: "Light fix: grammar, clarity & flow — no new content",
  },
  grammar: {
    id: "grammar",
    label: "Fix grammar",
    hint: "Spelling & grammar only, wording untouched",
  },
  enrich: {
    id: "enrich",
    label: "Enrich",
    hint: "Add a little detail (stays on your subject)",
  },
  shorten: {
    id: "shorten",
    label: "Make concise",
    hint: "Tighten without losing intent",
  },
};

export interface AssistFieldMeta {
  id: AssistField;
  /** Human label for tooltips ("AI: enrich the story"). */
  label: string;
  /** The action the plain button performs (the "default one" per field). */
  defaultMode: AssistMode;
  /** Modes offered for this field, in menu order (must include `defaultMode`). */
  modes: AssistMode[];
}

// Default is always the conservative `polish`; enrich/shorten are opt-in extras.
export const ASSIST_FIELD_META: Record<AssistField, AssistFieldMeta> = {
  story: { id: "story", label: "story", defaultMode: "polish", modes: ["polish", "grammar", "enrich", "shorten"] },
  settings: {
    id: "settings",
    label: "settings",
    defaultMode: "polish",
    modes: ["polish", "grammar", "enrich", "shorten"],
  },
  styleTheme: {
    id: "styleTheme",
    label: "style theme",
    defaultMode: "polish",
    modes: ["polish", "grammar", "enrich", "shorten"],
  },
  framePrompt: {
    id: "framePrompt",
    label: "frame prompt",
    defaultMode: "polish",
    modes: ["polish", "grammar", "enrich", "shorten"],
  },
  // A template is structural ({tokens}); only ever fix it mechanically.
  promptTemplate: {
    id: "promptTemplate",
    label: "prompt template",
    defaultMode: "grammar",
    modes: ["grammar", "polish"],
  },
  // A comma list of exclusions: tidy it (polish) or extend it (enrich).
  negativePrompt: {
    id: "negativePrompt",
    label: "negative prompt",
    defaultMode: "polish",
    modes: ["polish", "enrich"],
  },
};

/** Max characters of input text accepted (guards token cost / abuse). */
export const ASSIST_MAX_INPUT = 8000;

export const AssistRequestSchema = z
  .object({
    field: z.enum(ASSIST_FIELDS),
    mode: z.enum(ASSIST_MODES),
    text: z.string().max(ASSIST_MAX_INPUT).default(""),
    /** Field-aware context (story/settings/style/…) used to inform the revision. */
    context: z.record(z.string()).optional(),
  })
  .refine((r) => ASSIST_FIELD_META[r.field].modes.includes(r.mode), {
    message: "mode is not available for this field",
    path: ["mode"],
  });
export type AssistRequest = z.infer<typeof AssistRequestSchema>;

export interface AssistResponse {
  /** The revised field value, ready to drop straight back into the input. */
  text: string;
  /** The model that produced it. */
  model: string;
}

export interface AssistConfig {
  /** True when a text model is registered AND its API key is set server-side. */
  available: boolean;
  /** Display name of the active model, or null when unavailable. */
  model: string | null;
}

/** Trim + clip a context value so a long story doesn't blow up the prompt. */
function clip(value: string, max = 600): string {
  const t = value.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/**
 * Build the field-aware context for an assist request: the surrounding project
 * material most useful for revising *this* field. Deterministic and shared by the
 * client (which sends it) so the model always knows "which input it is" and what
 * world it lives in. Empty values are omitted.
 */
export function buildAssistContext(
  project: ComicProject,
  field: AssistField,
  frame?: ComicFrame,
): Record<string, string> {
  const ctx: Record<string, string> = {};
  const add = (key: string, value?: string) => {
    const t = (value ?? "").trim();
    if (t) ctx[key] = clip(t);
  };
  const styleTheme = project.style.theme;

  switch (field) {
    case "story":
      add("settings", project.settings);
      add("visual style", styleTheme);
      break;
    case "settings":
      add("story", project.story);
      add("visual style", styleTheme);
      break;
    case "styleTheme":
      add("story", project.story);
      add("settings", project.settings);
      break;
    case "framePrompt": {
      add("story", project.story);
      add("settings", project.settings);
      add("visual style", styleTheme);
      if (frame) {
        const i = project.frames.findIndex((f) => f.id === frame.id);
        if (i >= 0) add("frame position", `frame ${i + 1} of ${project.frames.length}`);
        const ids = frame.characterIds;
        const cast = ids === undefined ? project.cast : project.cast.filter((c) => ids.includes(c.id));
        const names = cast.map((c) => c.name.trim()).filter(Boolean);
        if (names.length) add("characters in frame", names.join(", "));
      }
      break;
    }
    case "promptTemplate":
      add("story", project.story);
      add("settings", project.settings);
      add("visual style", styleTheme);
      break;
    case "negativePrompt":
      add("visual style", styleTheme);
      break;
  }
  return ctx;
}
