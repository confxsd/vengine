import type { Hono } from "hono";
import type { ChatMessage } from "@vengine/providers";
import {
  DraftParseRequestSchema,
  DraftParseSchema,
  type DraftParse,
  type DraftSeriesRef,
  type Library,
  type Series,
} from "@vengine/shared";
import type { Runtime } from "./runtime.js";

/**
 * Draft-import routes. An author pastes a free-form story draft (frame markers,
 * `(parenthetical)` scene directions, dialogue / inner-voice) and a text model reads
 * the whole thing into a structured, reviewable `DraftParse` — an overall story +
 * one frame per beat, each with a prompt-ready VISUAL description and the beat's
 * script kept as metadata. The client shows the parse for review, then applies it.
 *
 * When the draft resolves to a **series** (a shared visual universe — explicit
 * `seriesId`, or auto-detected by keyword/cast-name hits), the parse becomes
 * universe-aware: the system prompt carries the premise and the canonical cast, and
 * the model must normalize `characters[]` to canonical names and keep each
 * character's established look. Style still comes from the series' style pack at
 * apply time — never from the parse.
 *
 * All prompt-craft lives in the config below (system prompt + the exact JSON shape we
 * ask for), so tuning the extraction is data, not control flow — mirroring the assist
 * and scene routes. The parse is returned to the client; this route never mutates a
 * project (the client owns that, so the author can review/edit first).
 */

/** Preferred text model; falls back to whatever is registered first. */
const DEFAULT_TEXT_MODEL = "deepseek/chat";

/** Output rules + the exact JSON shape we want back. Keep in lockstep with `DraftParseSchema`. */
const SYSTEM_PROMPT = `You are a story editor and storyboard artist inside vengine, a studio for contemporary-art comics. Each comic is a short sequence of 9:16 vertical single drawings. CRITICAL: the images render NO text — no speech bubbles, captions, signage, or written words. Anything a character says or thinks must be conveyed VISUALLY (facial expression, body language, posture, gesture, staging, environment), never as text drawn in the image.

You are given the author's raw, messy draft. It usually marks frames (e.g. "frame1", "frame 2:", "---"), puts visual directions in (parentheses), and writes dialogue and inner-voice as prose. Split it into the author's intended beats and turn each into one drawing.

Return ONLY a single JSON object — no markdown, no code fences, no commentary. Use exactly these keys:
{
  "title": string,            // a short title inferred from the draft (or "")
  "story": string,            // 2-4 sentences: the overall narrative arc, as prose (NOT a shot list)
  "storyMood": string,        // the story's prevailing emotional tone, derived from its THEME and arc (e.g. "tender, melancholic, quietly hopeful") — "" if unclear
  "settings": string,         // the shared world/setting/era/atmosphere every frame inherits
  "frames": [                 // one entry per beat, in reading order
    {
      "prompt": string,       // a vivid, prompt-ready VISUAL description of THIS single drawing: subject(s), their expression and posture (derived from what they say/feel), action, setting, composition and camera. Concrete and self-contained. NO on-image text, speech bubbles, or captions.
      "script": string,       // this beat's original dialogue / inner-voice / narration, lightly cleaned, keeping speaker labels (e.g. "Inner voice: …", "Secretary: …"). This is the author's text, preserved — it is NOT drawn in the image.
      "characters": string[], // names of characters VISIBLY PRESENT in this frame (see the "visible only" rule)
      "thread": string,       // storyline label (see the "storylines" rule); "" when the draft has just one storyline
      "mood": string,         // this beat's tone — ONLY where it breaks from "storyMood" or separates an interleaved storyline; else ""
      "palette": string[],    // 3-6 colors (hex or names) for this beat's storyline — ONLY when storylines need visual contrast; else []
      "continues": number     // OPTIONAL: 0-based index of an earlier frame this beat continues (same scene, moments later) — including NON-ADJACENT frames of an interleaved storyline
    }
  ]
}

Rules:
- Translate emotion and subtext into what is VISIBLE. If a character is devastated, the prompt shows the slumped shoulders, the tilted head, the stare at their hand — not the words.
- VISIBLE ONLY: "prompt" and "characters" contain ONLY what the camera actually sees in this beat. People, places or things that are merely mentioned, planned, remembered or discussed in the dialogue do NOT appear — if a couple is walking through a park and one says "let's visit the fortune teller", the drawing shows just the couple in the park: no fortune teller, no tent, no fortune-teller clothing or props. A mentioned thing materializes only in the later beat that actually shows it. "characters" lists only who is on screen in THIS frame.
- STORYLINES: a story may weave several storylines — a framing story (someone telling or hearing a tale) and the story told inside it, a flashback, a dream, a cutaway — and they can interleave (frames 1 & 4 one storyline, frames 2 & 3 another). When they do: give each storyline a short, stable "thread" label ("" for a single-storyline draft); keep each thread's setting, staging and characters consistent within itself; and make the storylines read VISUALLY DISTINCT from each other — separate "mood" and "palette" per thread (e.g. the bar's sickly greens vs the memory's warm dusk). Contrast BETWEEN storylines, consistency WITHIN one — never change the art style or medium; contrast comes from palette, lighting and mood. When a beat literally continues an earlier frame's scene (same place, moments later), set "continues" to that frame's 0-based index — including a NON-ADJACENT frame of an interleaved storyline (frame 4 continuing frame 1). Omit "continues" when the beat starts its own scene.
- Preserve the author's voice and content in "script" verbatim-ish; do not invent new dialogue.
- Do NOT invent a visual art style, medium, or palette for the whole draft — the author sets that elsewhere. (Per-storyline "palette" accents are the one exception, and only for interleaved storylines.) Describe subject, staging, expression and camera only.
- Never write on-image text, signage, logos, or brand names into "prompt".
- Keep the author's beat count: one frame per marked frame. If the draft has no markers, split on natural scene changes.
- If a field is unknown, use an empty string or empty array. Always return valid JSON.`;

/** Appended to the system prompt when the draft resolved to a series (universe). */
const SERIES_PROMPT = (series: Series, cast: Library["characters"]): string => `

This story belongs to the series "${series.name || "untitled"}" — a shared visual universe. Treat it as established canon:
${series.concept || series.description || "(no premise recorded)"}

Canonical cast (recurring characters of the universe)${
  cast.length
    ? ":\n" +
      cast
        .map((c) => {
          const aka = c.aliases.length ? ` (also called: ${c.aliases.join(", ")})` : "";
          return `- ${c.name}${aka}${c.description ? ` — ${c.description}` : ""}`;
        })
        .join("\n")
    : ": none recorded."
}

Additional rules for this series:
- In "characters", use each character's CANONICAL name above whenever the draft refers to them by any name or alias (e.g. "batman" → "Bruce Wayne"). One-off characters the universe doesn't know keep the draft's own name.
- In "prompt", keep each canonical character's established look consistent with their description (build, features, wardrobe signature) while staging the new scene. Story-specific wardrobe notes from the draft's directions still apply.`;

const USER_INSTRUCTION =
  "Parse this draft into the JSON object specified. Output JSON only.\n\nDRAFT:\n";

/**
 * Pull a `DraftParse` out of a model reply that is *supposed* to be JSON but may
 * arrive fenced or with stray prose. Strip code fences, isolate the first balanced
 * `{...}`, parse leniently (schema defaults fill any missing field). On total
 * failure, degrade gracefully: keep the raw text as the story so nothing is lost.
 * Mirrors `parseBreakdown` in `scenes.ts`.
 */
export function parseDraftReply(raw: string): DraftParse {
  const cleaned = raw.replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const parsed = DraftParseSchema.safeParse(JSON.parse(cleaned.slice(start, end + 1)));
      if (parsed.success) return parsed.data;
    } catch {
      /* fall through to the raw-story fallback */
    }
  }
  return DraftParseSchema.parse({ story: cleaned });
}

/** Count whole-word, case-insensitive hits of one keyword in the text. Multi-word
 * keywords (e.g. "wayne manor") match as a phrase. Returns the keyword when it hit. */
function keywordHit(text: string, keyword: string): string | null {
  const k = keyword.trim().toLowerCase();
  if (!k) return null;
  const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`, "i").test(text) ? k : null;
}

export interface ResolvedSeries {
  series: Series;
  /** The cast entries the series references (resolved from the library). */
  cast: Library["characters"];
  /** Signals that matched (keywords / cast names) — empty for an explicit pick. */
  matchedBy: string[];
}

/**
 * Resolve which universe (series) a draft belongs to: an explicit `seriesId` wins;
 * otherwise every series is scored by keyword + cast-name/alias hits against the
 * text (word-boundary, case-insensitive) and the best above zero is picked — with
 * a tie broken by more cast presence, since named characters are the stronger signal.
 */
export function detectSeries(library: Library, text: string, seriesId?: string): ResolvedSeries | null {
  const lower = text.toLowerCase();
  if (seriesId) {
    const series = library.series.find((s) => s.id === seriesId);
    if (!series) return null;
    const cast = library.characters.filter((c) => series.castIds.includes(c.id));
    return { series, cast, matchedBy: [] };
  }
  let best: ResolvedSeries | null = null;
  for (const series of library.series) {
    const cast = library.characters.filter((c) => series.castIds.includes(c.id));
    const matchedBy: string[] = [];
    for (const keyword of series.keywords) {
      const hit = keywordHit(lower, keyword);
      if (hit) matchedBy.push(hit);
    }
    for (const c of cast) {
      for (const name of [c.name, ...c.aliases]) {
        const hit = keywordHit(lower, name);
        if (hit) matchedBy.push(hit);
      }
    }
    if (
      matchedBy.length > 0 &&
      (!best || matchedBy.length > best.matchedBy.length || (matchedBy.length === best.matchedBy.length && cast.length > best.cast.length))
    ) {
      best = { series, cast, matchedBy };
    }
  }
  return best;
}

function seriesRef(resolved: ResolvedSeries | null): DraftSeriesRef | null {
  return resolved ? { id: resolved.series.id, name: resolved.series.name, matchedBy: resolved.matchedBy } : null;
}

export function registerDraftRoutes(app: Hono, rt: Runtime): void {
  const resolveModel = () => rt.textProviders.get(DEFAULT_TEXT_MODEL) ?? rt.textProviders.list()[0];

  // Availability probe so the client only offers draft import when usable.
  app.get("/api/draft/config", (c) => {
    const model = resolveModel();
    const apiKey = model ? rt.services.getApiKey?.(model.provider) : undefined;
    return c.json({ available: !!(model && apiKey), model: model?.displayName ?? null });
  });

  // Parse a raw draft into a structured, reviewable storyboard. Universe-aware:
  // an explicit seriesId or a keyword/cast-name auto-detection steers the parse.
  app.post("/api/draft/parse", async (c) => {
    const parsed = DraftParseRequestSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);

    const model = resolveModel();
    if (!model) return c.json({ error: "No text model is registered." }, 503);
    const apiKey = rt.services.getApiKey?.(model.provider);
    if (!apiKey) {
      return c.json(
        { error: `Set ${model.provider.toUpperCase()}_KEY in the server env to import drafts.` },
        503,
      );
    }

    let resolved: ResolvedSeries | null = null;
    try {
      resolved = detectSeries(await rt.library.get(), parsed.data.text, parsed.data.seriesId);
    } catch {
      /* a library read failure must not break parsing — just parse universe-less */
    }

    const messages: ChatMessage[] = [
      {
        role: "system",
        content: resolved ? SYSTEM_PROMPT + SERIES_PROMPT(resolved.series, resolved.cast) : SYSTEM_PROMPT,
      },
      { role: "user", content: `${USER_INSTRUCTION}${parsed.data.text.trim()}` },
    ];

    try {
      // Low temperature for faithful, deterministic structure; generous token budget
      // so a multi-frame JSON is never truncated mid-object (which would break parsing).
      const result = await model.complete(
        { messages, temperature: 0.3, maxTokens: 4096 },
        { apiKey },
      );
      return c.json({ ...parseDraftReply(result.text), model: result.model, series: seriesRef(resolved) });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
  });
}
