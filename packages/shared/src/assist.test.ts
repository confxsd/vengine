import { describe, it, expect } from "vitest";
import {
  ASSIST_FIELD_META,
  ASSIST_FIELDS,
  AssistRequestSchema,
  buildAssistContext,
} from "./assist.js";
import { ComicProjectSchema, type ComicProject } from "./comic.js";

function project(): ComicProject {
  return ComicProjectSchema.parse({
    id: "p1",
    name: "Test",
    story: "A lonely lighthouse keeper befriends a storm.",
    settings: "A windswept northern coast, late autumn.",
    style: { theme: "muted ink wash, heavy grain" },
    cast: [
      { id: "c1", name: "Mara", refHashes: [] },
      { id: "c2", name: "The Storm", refHashes: [] },
    ],
    frames: [
      { id: "f1", prompt: "wide shot of the lighthouse" },
      { id: "f2", prompt: "" },
    ],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
}

describe("assist field metadata", () => {
  it("every field's defaultMode is one of its offered modes", () => {
    for (const field of ASSIST_FIELDS) {
      const meta = ASSIST_FIELD_META[field];
      expect(meta.modes).toContain(meta.defaultMode);
      expect(meta.modes.length).toBeGreaterThan(0);
    }
  });
});

describe("AssistRequestSchema", () => {
  it("rejects a mode not offered for the field", () => {
    // negativePrompt only offers "enrich".
    const bad = AssistRequestSchema.safeParse({ field: "negativePrompt", mode: "grammar", text: "x" });
    expect(bad.success).toBe(false);
  });

  it("accepts a valid request and defaults empty text", () => {
    const ok = AssistRequestSchema.safeParse({ field: "story", mode: "enrich" });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.text).toBe("");
  });
});

describe("buildAssistContext", () => {
  it("gives a frame prompt the story, settings, style, position, and active cast", () => {
    const p = project();
    const ctx = buildAssistContext(p, "framePrompt", p.frames[0]);
    expect(ctx.story).toContain("lighthouse keeper");
    expect(ctx.settings).toContain("northern coast");
    expect(ctx["visual style"]).toContain("ink wash");
    expect(ctx["frame position"]).toBe("frame 1 of 2");
    expect(ctx["characters in frame"]).toBe("Mara, The Storm");
  });

  it("respects a frame's explicit character subset", () => {
    const p = project();
    const frame = { ...p.frames[0]!, characterIds: ["c2"] };
    const ctx = buildAssistContext(p, "framePrompt", frame);
    expect(ctx["characters in frame"]).toBe("The Storm");
  });

  it("omits empty context values", () => {
    const p = ComicProjectSchema.parse({
      id: "p2",
      name: "Empty",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const ctx = buildAssistContext(p, "story");
    expect(Object.keys(ctx)).toHaveLength(0);
  });
});
