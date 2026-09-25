import type { Hono } from "hono";
import { z } from "zod";
import type { ChatMessage } from "@vengine/providers";
import type { ComicProject, Library, Series } from "@vengine/shared";
import {
  DIRECTOR_CONTEXT_MESSAGES,
  DIRECTOR_MAX_INPUT,
  DirectorReplySchema,
  applyDirectorChanges,
  type DirectorMessage,
  type DirectorTurnResult,
} from "@vengine/shared";
import type { Runtime } from "./runtime.js";

/**
 * Director-chat routes — the revision loop after import. The author discusses the
 * episode like a director (theme, subtext, character intent, mood), and a text model
 * replies with that discussion PLUS a structured change-set that this route applies
 * immediately (auto-apply per the author's choice), snapshotting first so any turn
 * is undoable. The model sees the whole universe: the episode, its series premise,
 * the canon cast's defining features, and one-line summaries of sibling episodes —
 * so "fix Batman 4's Bruce given the prequel" works across stories.
 *
 * All prompt-craft lives below (mirroring `draft.ts`); the typed change contract and
 * the deterministic applier live in `@vengine/shared` `director.ts`.
 */

const DEFAULT_TEXT_MODEL = "openrouter/glm-5.3-flash";

const MessageBody = z.object({ text: z.string().min(1).max(DIRECTOR_MAX_INPUT) });

/** Output rules + the exact JSON shape we want back. Keep in lockstep with `DirectorReplySchema`. */
const SYSTEM_PROMPT = `You are the story director inside vengine, a studio for contemporary-art comics — a script doctor the author talks to about their episode. Each comic is a short sequence of 9:16 vertical single drawings. CRITICAL: the images render NO text — anything a character says or thinks must be conveyed VISUALLY (expression, posture, gesture, staging), never as drawn text.

You have TWO jobs every turn:
1. DISCUSS — analyze the author's note the way a great script doctor would: theme and subtext, character motivation, the emotional arc across frames, what each beat is really about. Be specific, cite frames and characters, keep it conversational and reasonably brief (this is a chat, not an essay).
2. DECIDE — translate the discussion into precise structured edits to the story data, so the author never has to hand-fix fields. Return ONLY a single JSON object — no markdown, no code fences:
{
  "reply": string,   // your discussion (shown in the chat)
  "changes": [       // the edits to apply, in order; [] when the note is pure discussion
    { "op": "updateProject", "story"?, "storyMood"?, "settings"?, "styleTheme"?, "palette"?: string[] },
    { "op": "updatePlan", "structure"?: "kishotenketsu"|"detonate"|"continuous"|"framed-tale"|null, "archetype"?, "strategy"?, "theme"?, "motif"?, "token"?: string|null },
    { "op": "updateFrame", "frameIndex": number, "prompt"?, "script"?, "camera"?, "mood"?, "thread"?: string|null, "palette"?: string[]|null, "characterNames"?: string[]|null, "continuesFrameIndex"?: number|null, "role"?: "establish"|"develop"|"escalate"|"turn"|"settle"|"payoff"|null, "gutter"?: "moment"|"action"|"subject"|"scene"|"aspect"|"nonsequitur"|null, "echoFrameIndex"?: number|null },
    { "op": "addFrame", "afterIndex": number, "prompt": string, "script"?, "mood"?, "thread"?, "palette"?: string[], "characterNames"?: string[] },
    { "op": "deleteFrame", "frameIndex": number },
    { "op": "moveFrame", "from": number, "to": number },
    { "op": "upsertCharacter", "name": string, "aliases"?: string[], "description"?: string|null, "palette"?: string[] },
    { "op": "setCharacterEra", "name": string, "era": string, "description"?: string },
    { "op": "updateSeries", "concept"?, "description"? }
  ]
}

Semantics:
- Indices are 0-based positions in the CURRENT frame list given in the context.
- In each change, OMIT a field to keep it; set it to null (where allowed) to CLEAR it.
- "characterNames": null means "whole cast appears"; an array means exactly those characters (any name or alias they're known by).
- THE PLAN: the episode's creative configuration — structure (which proven 4-beat form), archetype (art direction), strategy (the experiment), theme, motif (the recurring image that pays off), token (passed to the next episode). Critique the episode AGAINST its plan: "P3 isn't reading as the turn — camera too close to P2", "the motif never recurs before the payoff", "this wants detonate, not kishōtenketsu". Edit it with "updatePlan"; changing "structure" automatically remaps every frame's role to the new slot map.
- ROLES: each frame carries its role in the structure — establish / develop / escalate / turn / settle / payoff. Edit per-frame with "role" (null clears). The turn (or payoff) panel should take the episode's biggest camera change; P2 must add new information, never restate P1.
- GUTTERS: each frame i≥1 carries the typed transition INTO it from the previous panel — moment (a heartbeat later) / action (meaningfully later — the default) / subject (same beat, new focal subject) / scene (a jump; at most one per episode) / aspect (no subject, texture/weather/light; first half only) / nonsequitur (a hard cut). Edit with "gutter" (null clears).
- ECHO: a frame may mirror a strictly-earlier frame's composition — the bookend payout (P4 mirrors P1, changing exactly one thing). Set with "echoFrameIndex" (null clears). The echo governs composition, so a frame shouldn't also carry a continuation link.
- "upsertCharacter" updates the canon character when the name/alias exists, otherwise creates one; "description" is the character's defining features (build, face, wardrobe signature) reused across every story for consistency.
- ERAS: the same character recurs at different life stages across episodes (teen Bruce, young Bruce, mature Bruce…). Each canon character may carry named eras with their own age-bearing look. Use "setCharacterEra" to pin which era THIS episode's cast is in (e.g. era "teen"); give "description" when defining/refining what changes at that stage (age, build, face, wardrobe of THAT era). Then write frame prompts consistent with that stage's look.
- STORYLINES: an episode may weave several storylines — a framing story (someone telling a tale) and the story told inside it, a flashback, a dream, a cutaway — and they can interleave (e.g. frames 1 & 4 the Joker in the bar, frames 2 & 3 his tale). Frames carry a "thread" label naming their storyline (absent = the main storyline). Make storylines read VISUALLY DISTINCT from each other — give each thread its own "mood" and "palette" (its colors override the episode palette for that frame) and keep them consistent within the thread. Contrast BETWEEN storylines, consistency WITHIN one; NEVER change the art style or medium — contrast comes from palette, lighting and mood only. Link a beat to the earlier frame it literally continues via "continuesFrameIndex", INCLUDING non-adjacent frames of an interleaved storyline (frame 4 continuing frame 1).
- "updateSeries" edits the universe itself (premise/lore) — use sparingly and only when the author asks.

Editing discipline (what the author relies on you to fix):
- "prompt" must be a vivid, self-contained VISUAL description of the single drawing, COMPOSED LIKE A PAINTER: a deliberate cinematic composition (dynamic framing, layered depth, purposeful negative space, staging that tells who holds power in the beat), precise figure work (each posture, weight, gesture, hand, gaze and facial expression derived from the subtext; distance and orientation between figures carrying the relationship), motivated lighting, and one or two symbolic objects that comment on the beat. Nothing generic — every element placed with intention. NO on-image text, speech bubbles, captions, logos.
- "prompt" and "characterNames" contain ONLY what the camera actually sees in the beat. People, places or things merely mentioned, planned, remembered or discussed in dialogue do NOT appear — a fortune teller the couple only TALKS about visiting is not in the drawing until a beat actually shows her. Strip such leakage when you find it, and never cast a character who isn't on screen.
- Derive mood from the story's THEME and emotional arc, not generic labels: "what kind of cat am I" is anxious self-interrogation, an interrupted diary is intimacy punctured by the mundane. Set "storyMood" once for the episode's prevailing tone, and per-frame "mood" only where a beat breaks from it (e.g. a final panel turning "quietly liberated, contemplative").
- Keep each character's defining features consistent with the canon descriptions in the context; if the canon description is thin, improve it via "upsertCharacter".
- Do NOT invent an art style or medium into frame prompts — style lives in "styleTheme".
- Only emit changes you are confident about; an ambiguous note gets discussed in "reply" with [] changes. Always return valid JSON.`;

// ── Context building ─────────────────────────────────────────────────────────

/** Compact, prompt-safe view of one frame: enough for the model to edit by index. */
function frameSummary(project: ComicProject, i: number): string {
  const f = project.frames[i]!;
  const castNames = f.characterIds
    ? project.cast
        .filter((c) => f.characterIds!.includes(c.id))
        .map((c) => c.name)
        .join(", ")
    : "(whole cast)";
  const cont = f.continuesFrameId
    ? project.frames.findIndex((x) => x.id === f.continuesFrameId)
    : -1;
  const echo = f.echoFrameId
    ? project.frames.findIndex((x) => x.id === f.echoFrameId)
    : -1;
  return [
    `  [${i}] role: ${f.role || "-"} · gutter: ${f.gutter || "-"} · thread: ${f.thread || "(main)"} · camera: ${f.camera || "-"} · mood: ${
      f.mood || "-"
    } · cast: ${castNames}${f.palette?.length ? ` · palette: ${f.palette.join(", ")}` : ""}${
      cont >= 0 ? ` · continues [${cont}]` : ""
    }${echo >= 0 ? ` · echoes [${echo}]` : ""}`,
    `      prompt: ${f.prompt.slice(0, 300)}`,
    f.script ? `      script: ${f.script.slice(0, 200)}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

/** The episode plan as compact context lines (omitted when the project has none). */
function planSummary(project: ComicProject): string | null {
  const plan = project.plan;
  if (!plan) return null;
  const fields = [
    `structure: ${plan.structure}`,
    plan.archetype ? `archetype: ${plan.archetype}` : "",
    plan.strategy ? `strategy: ${plan.strategy}` : "",
    plan.theme ? `theme: ${plan.theme}` : "",
    plan.motif ? `motif: ${plan.motif}` : "",
    plan.token ? `token (next episode): ${plan.token}` : "",
  ].filter(Boolean);
  return [`EPISODE PLAN (critique the frames against it):`, ...fields.map((l) => `  ${l}`)].join(
    "\n",
  );
}

/** One-line sibling episode digest, so cross-story direction has the context. */
async function siblingDigest(
  rt: Runtime,
  series: Series | null,
  currentId: string,
): Promise<string> {
  if (!series) return "(standalone episode — no universe)";
  const ids = series.projectIds.filter((id) => id !== currentId).slice(0, 8);
  if (!ids.length) return `universe "${series.name}" — no other episodes yet`;
  const lines: string[] = [];
  for (const id of ids) {
    try {
      const p = await rt.projects.get(id);
      const beats = p.frames
        .slice(0, 6)
        .map((f, i) => `    [${i}] ${f.prompt.slice(0, 100)}`)
        .join("\n");
      lines.push(`- ${p.name} (${p.frames.length} frames)\n${beats}`);
    } catch {
      /* a missing project must not break the turn */
    }
  }
  return lines.length
    ? `other episodes of "${series.name}" (for cross-story consistency):\n${lines.join("\n")}`
    : `universe "${series.name}" — no other episodes readable`;
}

function canonCast(library: Library, series: Series | null): string {
  const cast = series
    ? library.characters.filter((c) => series.castIds.includes(c.id))
    : library.characters.slice(0, 12);
  if (!cast.length) return "(no canon characters recorded)";
  return cast
    .map((c) => {
      const aka = c.aliases.length ? ` (also: ${c.aliases.join(", ")})` : "";
      const pal = c.palette.length ? ` · palette: ${c.palette.join(", ")}` : "";
      const eras = c.eras.length
        ? `\n    eras: ${c.eras
            .map(
              (e) =>
                `${e.label}${e.description ? ` — ${e.description}` : ""}${
                  e.refHashes.length ? ` (${e.refHashes.length} refs)` : " (no refs yet)"
                }`,
            )
            .join(" | ")}`
        : "";
      return `- ${c.name}${aka}${c.description ? ` — ${c.description}` : "(no description yet)"}${pal}${eras}`;
    })
    .join("\n");
}

function buildContext(
  project: ComicProject,
  library: Library,
  series: Series | null,
  siblings: string,
): string {
  return [
    `EPISODE: "${project.name}"`,
    `story: ${project.story || "(none)"}`,
    `story mood: ${project.storyMood || "(none)"}`,
    `settings: ${project.settings || "(none)"}`,
    `style theme (do not duplicate into frame prompts): ${project.style.theme}`,
    `palette: ${project.style.palette.join(", ") || "(none)"}`,
    planSummary(project) ?? "",
    `frames (${project.frames.length}, indices 0-based):\n${project.frames
      .map((_, i) => frameSummary(project, i))
      .join("\n") || "  (none)"}`,
    ...(project.cast.length
      ? [
          `this episode's cast: ${project.cast
            .map((c) => `${c.name}${c.eraLabel ? ` [era: ${c.eraLabel}]` : ""}`)
            .join(", ")}`,
        ]
      : []),
    "",
    `UNIVERSE${series ? `: "${series.name}"` : ""}`,
    series ? `premise: ${series.concept || series.description || "(none)"}` : "",
    `canon cast:\n${canonCast(library, series)}`,
    "",
    siblings,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Pull a `DirectorReply` out of a model reply that should be JSON but may be fenced
 * or carry stray prose. Lenient like `parseDraftReply`; on total failure the raw
 * text becomes the discussion with no changes (never throws away the model's work).
 */
export function parseDirectorReply(raw: string) {
  const cleaned = raw.replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const parsed = DirectorReplySchema.safeParse(JSON.parse(cleaned.slice(start, end + 1)));
      if (parsed.success) return parsed.data;
    } catch {
      /* fall through to raw-reply */
    }
  }
  return DirectorReplySchema.parse({ reply: cleaned });
}

export function registerDirectorRoutes(app: Hono, rt: Runtime): void {
  const resolveModel = () =>
    rt.textProviders.get(DEFAULT_TEXT_MODEL) ?? rt.textProviders.list()[0];

  // Availability probe (same pattern as draft/assist).
  app.get("/api/director/config", (c) => {
    const model = resolveModel();
    const apiKey = model ? rt.services.getApiKey?.(model.provider) : undefined;
    return c.json({ available: !!(model && apiKey), model: model?.displayName ?? null });
  });

  // Conversation history for an episode.
  app.get("/api/comics/:id/director", async (c) => {
    try {
      const project = await rt.projects.get(c.req.param("id"));
      return c.json({ messages: project.director ?? [] });
    } catch {
      return c.json({ error: "not found" }, 404);
    }
  });

  // One director turn: discuss + decide, auto-apply, snapshot first.
  app.post("/api/comics/:id/director", async (c) => {
    const id = c.req.param("id");
    const parsed = MessageBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);

    const model = resolveModel();
    if (!model) return c.json({ error: "No text model is registered." }, 503);
    const apiKey = rt.services.getApiKey?.(model.provider);
    if (!apiKey) {
      return c.json(
        { error: `Set ${model.provider.toUpperCase()}_KEY in the server env to use the director.` },
        503,
      );
    }

    let project: ComicProject;
    try {
      project = await rt.projects.get(id);
    } catch {
      return c.json({ error: "not found" }, 404);
    }

    let library: Library;
    try {
      library = await rt.library.get();
    } catch {
      library = { characters: [], styles: [], trainedLoras: [], scenes: [], series: [] };
    }
    const series = project.seriesId ? library.series.find((s) => s.id === project.seriesId) ?? null : null;

    // Undo point: every applied turn is snapshot-recoverable.
    try {
      await rt.projects.createSnapshot(id);
    } catch {
      /* snapshotting must not block the turn */
    }

    const history = (project.director ?? []).slice(-DIRECTOR_CONTEXT_MESSAGES);
    const messages: ChatMessage[] = [
      {
        role: "system",
        content:
          SYSTEM_PROMPT +
          (series
            ? `\n\nThis episode belongs to the series "${series.name}" — treat its premise and canon cast as established canon, and keep characters consistent with it.`
            : ""),
      },
      ...history.map((m): ChatMessage => ({ role: m.role, content: m.text })),
      {
        role: "user",
        content: `CURRENT STORY DATA:\n${buildContext(project, library, series, await siblingDigest(rt, series, id))}\n\nDIRECTOR'S NOTE:\n${parsed.data.text.trim()}\n\nRespond with the JSON object specified (discussion in "reply", edits in "changes").`,
      },
    ];

    let replyText: string;
    try {
      // Same headroom rationale as the draft route: rewritten frame prompts run
      // long and reasoning-style models bill hidden tokens against the cap.
      const result = await model.complete(
        { messages, temperature: 0.4, maxTokens: 8192 },
        { apiKey },
      );
      replyText = result.text;
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }

    const reply = parseDirectorReply(replyText);

    // Apply ONCE to the LATEST document under the store lock (preserves concurrent
    // variant merges), capturing the result for the library/series side effects.
    // (Box object: a bare `let` assigned inside the store's callback narrows to
    // `never` at the read site under CFA.)
    const appliedBox: { value?: ReturnType<typeof applyDirectorChanges> } = {};
    let saved = project;
    try {
      saved = await rt.projects.update(id, (latest) => {
        appliedBox.value = applyDirectorChanges(latest, library, series, reply.changes);
        return appliedBox.value.project;
      });
      const applied = appliedBox.value;
      if (applied) {
        for (const char of applied.dirtyCharacters) await rt.library.upsertCharacter(char);
        if (applied.series) await rt.library.upsertSeries(applied.series);
      }
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
    const applied = appliedBox.value;
    const log = applied?.log ?? [];
    const skipped = applied?.skipped ?? [];

    // Append the turn to the on-project history.
    const now = new Date().toISOString();
    const userTurn: DirectorMessage = {
      role: "user",
      text: parsed.data.text.trim(),
      changes: [],
      log: [],
      at: now,
    };
    const turn: DirectorMessage = {
      role: "assistant",
      text: reply.reply,
      changes: reply.changes,
      log: [...log, ...skipped.map((s) => `skipped — ${s}`)],
      at: now,
    };
    try {
      saved = await rt.projects.update(id, (latest) => ({
        ...latest,
        director: [...(latest.director ?? []), userTurn, turn].slice(-200),
      }));
    } catch {
      /* history persistence is best-effort; the edits already landed */
    }

    const result: DirectorTurnResult = { reply: reply.reply, log: turn.log, project: saved };
    return c.json(result);
  });
}
