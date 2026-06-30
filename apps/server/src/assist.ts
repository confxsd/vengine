import type { Hono } from "hono";
import type { ChatMessage } from "@vengine/providers";
import { AssistRequestSchema, type AssistField, type AssistMode } from "@vengine/shared";
import type { Runtime } from "./runtime.js";

/**
 * AI text-assist routes. Turns a field + mode + the surrounding context into a
 * seeded chat completion, then returns the revised text to drop straight back
 * into the input. All prompt-craft is config-driven (the maps below) so adding a
 * field or mode is a single entry, never new control flow.
 */

/** Preferred text model; falls back to whatever is registered first. */
const DEFAULT_TEXT_MODEL = "deepseek/chat";

/** Shared rules every revision must obey, regardless of field or mode. */
const GLOBAL_SYSTEM = `You are a careful, conservative copy editor inside vengine, a studio for contemporary-art comics (vertical 9:16 single drawings, no text rendered in the image).
You revise ONE text field the author is editing. Your job is to FIX it, not to rewrite it.

Be minimal and faithful:
- Make the SMALLEST change that achieves the task. If the text is already fine, return it unchanged.
- Keep the author's own words, phrasing, voice, meaning, and intent. Do not paraphrase what is already correct.
- Keep roughly the same length and the same formatting and line breaks.
- Do NOT add new ideas, subjects, objects, imagery, mood, or artistic direction the author did not write.
- Do NOT change the medium, art style, palette, or genre. Add no creative "flavor" of your own.
- Keep any {tokens} in curly braces exactly as-is. Never invent on-image text, signage, or brand names.

Output rules:
- Return ONLY the revised field value — no preamble, explanation, quotes, markdown, or labels.
- The Context provided is background ONLY. NEVER copy the visual style, setting, or any context value into this field; those are applied elsewhere.`;

/** What each field IS — so the model revises it in the right register. */
const FIELD_PROMPTS: Record<AssistField, string> = {
  story:
    "This field is the comic's overall STORY / narrative arc — the throughline that gives the frames continuity. Write prose, not a shot list.",
  settings:
    "This field is the shared SETTINGS — the world, place, era, and atmosphere every frame inherits. Describe the world, not a single scene.",
  styleTheme:
    "This field is the VISUAL STYLE theme — medium, palette, linework, lighting, texture, and rendering applied to every frame. Describe the look, never the narrative.",
  framePrompt:
    "This field is ONE frame's scene prompt — the concrete subject, action, composition, and camera for a single drawing. Lead with the subject; keep it a single vivid description.",
  promptTemplate:
    "This field is the PROMPT TEMPLATE expanded for every frame. It MUST keep its {frame}, {settings}, {style}, and {story} tokens intact, each on a sensible line. Improve only the connective wording and structure around the tokens.",
  negativePrompt:
    "This field is the NEGATIVE prompt — a comma-separated list of things to keep OUT of the image. Output ONLY a comma-separated list of concise terms (no sentences).",
};

/** What each mode DOES to the field's current value (conservative by default). */
const MODE_PROMPTS: Record<AssistMode, string> = {
  polish:
    "Lightly fix grammar, spelling, punctuation, and clearly awkward phrasing — and nothing else. Keep the author's words, order, length, and meaning wherever they already work. Add no new content. If it is already clean, return it unchanged.",
  grammar:
    "Correct ONLY grammar, spelling, and punctuation. Do not rephrase, reorder, or change word choice or length.",
  enrich:
    "Add at most a few concrete details to flesh out only the vague parts, staying strictly on the author's existing subject, tone, and intent. Keep their wording and roughly their length; introduce no new art style, medium, palette, mood, or motif. If the current value is empty, write a short, plain first draft from the context.",
  shorten:
    "Remove redundancy to make it more concise. Keep the author's wording, meaning, and intent; add nothing.",
};

export function buildSystemPrompt(field: AssistField, mode: AssistMode): string {
  return `${GLOBAL_SYSTEM}\n\nField: ${FIELD_PROMPTS[field]}\n\nTask: ${MODE_PROMPTS[mode]}`;
}

export function buildUserMessage(text: string, context?: Record<string, string>): string {
  const parts: string[] = [];
  const entries = Object.entries(context ?? {});
  if (entries.length) {
    parts.push("Context (background only — do NOT copy any of it into your answer):");
    for (const [key, value] of entries) parts.push(`- ${key}: ${value}`);
    parts.push("");
  }
  const trimmed = text.trim();
  parts.push(trimmed ? `Current value (revise this):\n${trimmed}` : "The current value is empty.");
  return parts.join("\n");
}

/** Strip a single pair of wrapping quotes a model sometimes adds around its reply. */
function stripWrappingQuotes(s: string): string {
  const t = s.trim();
  const quoted =
    (t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"));
  return quoted && t.length >= 2 ? t.slice(1, -1).trim() : t;
}

export function registerAssistRoutes(app: Hono, rt: Runtime): void {
  const resolveModel = () => rt.textProviders.get(DEFAULT_TEXT_MODEL) ?? rt.textProviders.list()[0];

  // Availability probe so the client only shows the AI button when usable.
  app.get("/api/assist/config", (c) => {
    const model = resolveModel();
    const apiKey = model ? rt.services.getApiKey?.(model.provider) : undefined;
    return c.json({ available: !!(model && apiKey), model: model?.displayName ?? null });
  });

  // Revise a single field.
  app.post("/api/assist", async (c) => {
    const parsed = AssistRequestSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);

    const model = resolveModel();
    if (!model) return c.json({ error: "No text model is registered." }, 503);
    const apiKey = rt.services.getApiKey?.(model.provider);
    if (!apiKey) {
      return c.json(
        { error: `Set ${model.provider.toUpperCase()}_KEY in the server env to use AI assist.` },
        503,
      );
    }

    const { field, mode, text, context } = parsed.data;
    const messages: ChatMessage[] = [
      { role: "system", content: buildSystemPrompt(field, mode) },
      { role: "user", content: buildUserMessage(text, context) },
    ];

    try {
      const result = await model.complete({ messages }, { apiKey });
      return c.json({ text: stripWrappingQuotes(result.text), model: result.model });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
  });
}
