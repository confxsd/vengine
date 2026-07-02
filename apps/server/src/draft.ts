import type { Hono } from "hono";
import type { ChatMessage } from "@vengine/providers";
import { DraftParseRequestSchema, DraftParseSchema, type DraftParse } from "@vengine/shared";
import type { Runtime } from "./runtime.js";

/**
 * Draft-import routes. An author pastes a free-form story draft (frame markers,
 * `(parenthetical)` scene directions, dialogue / inner-voice) and a text model reads
 * the whole thing into a structured, reviewable `DraftParse` — an overall story +
 * one frame per beat, each with a prompt-ready VISUAL description and the beat's
 * script kept as metadata. The client shows the parse for review, then applies it.
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
  "settings": string,         // the shared world/setting/era/atmosphere every frame inherits
  "frames": [                 // one entry per beat, in reading order
    {
      "prompt": string,       // a vivid, prompt-ready VISUAL description of THIS single drawing: subject(s), their expression and posture (derived from what they say/feel), action, setting, composition and camera. Concrete and self-contained. NO on-image text, speech bubbles, or captions.
      "script": string,       // this beat's original dialogue / inner-voice / narration, lightly cleaned, keeping speaker labels (e.g. "Inner voice: …", "Secretary: …"). This is the author's text, preserved — it is NOT drawn in the image.
      "characters": string[]  // names of characters visibly present in this frame
    }
  ]
}

Rules:
- Translate emotion and subtext into what is VISIBLE. If a character is devastated, the prompt shows the slumped shoulders, the tilted head, the stare at their hand — not the words.
- Preserve the author's voice and content in "script" verbatim-ish; do not invent new dialogue.
- Do NOT invent a visual art style, medium, or palette — the author sets that elsewhere. Describe subject, staging, expression and camera only.
- Never write on-image text, signage, logos, or brand names into "prompt".
- Keep the author's beat count: one frame per marked frame. If the draft has no markers, split on natural scene changes.
- If a field is unknown, use an empty string or empty array. Always return valid JSON.`;

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

export function registerDraftRoutes(app: Hono, rt: Runtime): void {
  const resolveModel = () => rt.textProviders.get(DEFAULT_TEXT_MODEL) ?? rt.textProviders.list()[0];

  // Availability probe so the client only offers draft import when usable.
  app.get("/api/draft/config", (c) => {
    const model = resolveModel();
    const apiKey = model ? rt.services.getApiKey?.(model.provider) : undefined;
    return c.json({ available: !!(model && apiKey), model: model?.displayName ?? null });
  });

  // Parse a raw draft into a structured, reviewable storyboard.
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

    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `${USER_INSTRUCTION}${parsed.data.text.trim()}` },
    ];

    try {
      // Low temperature for faithful, deterministic structure; generous token budget
      // so a multi-frame JSON is never truncated mid-object (which would break parsing).
      const result = await model.complete(
        { messages, temperature: 0.3, maxTokens: 4096 },
        { apiKey },
      );
      return c.json({ ...parseDraftReply(result.text), model: result.model });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
  });
}
