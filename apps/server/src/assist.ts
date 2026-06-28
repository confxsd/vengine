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
const DEFAULT_TEXT_MODEL = "kimi/k2";

/** Shared rules every revision must obey, regardless of field or mode. */
const GLOBAL_SYSTEM = `You are the writing assistant inside vengine, a studio for creating contemporary-art comics: vertical 9:16 single drawings, one image per frame, with NO text, letters, captions, or speech bubbles rendered inside the image.
Your job is to revise ONE text field the author is editing.
Strict output rules:
- Return ONLY the revised field value — no preamble, no explanation, no quotes, no markdown, no labels.
- Preserve the author's language, voice, and intent.
- Keep any {tokens} written in curly braces exactly as-is.
- Be concrete and evocative but never bloated; never invent on-image text, signage, or brand names.`;

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

/** What each mode DOES to the field's current value. */
const MODE_PROMPTS: Record<AssistMode, string> = {
  enrich:
    "Enrich it: add vivid, specific, on-context detail and visual concreteness while staying faithful to the author's idea. If the current value is empty, draft a strong first version from the context.",
  grammar:
    "Fix grammar, spelling, and punctuation only. Keep the wording, structure, and meaning as close to the original as possible.",
  shorten: "Make it more concise and punchy without losing the essential meaning.",
};

export function buildSystemPrompt(field: AssistField, mode: AssistMode): string {
  return `${GLOBAL_SYSTEM}\n\nField: ${FIELD_PROMPTS[field]}\n\nTask: ${MODE_PROMPTS[mode]}`;
}

export function buildUserMessage(text: string, context?: Record<string, string>): string {
  const parts: string[] = [];
  const entries = Object.entries(context ?? {});
  if (entries.length) {
    parts.push("Context (use it to inform the revision; do NOT echo it back):");
    for (const [key, value] of entries) parts.push(`- ${key}: ${value}`);
    parts.push("");
  }
  const trimmed = text.trim();
  parts.push(trimmed ? `Current value:\n${trimmed}` : "The current value is empty — write one from scratch.");
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
