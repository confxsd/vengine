import type { SceneBreakdown } from "../types";

/**
 * Turn a scene breakdown into a single frame prompt. The caption is the spine (a
 * vision model already writes it as one prompt-ready paragraph); when it's empty we
 * compose from the structured facets instead. **Style is deliberately excluded** —
 * `styleNotes`/`palette` describe the *source* image's medium, but the whole point of
 * "Send to Studio" is to recompose the scene in the author's own style, which the
 * project's style pack supplies. So this carries composition, not look.
 */
export function sceneToPrompt(b: SceneBreakdown): string {
  const caption = b.caption.trim();
  if (caption) return caption;
  return [b.setting, b.subjects.join(", "), b.composition, b.lighting, b.mood]
    .map((s) => s.trim())
    .filter(Boolean)
    .join(". ");
}
