import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { DirectorChangeSchema } from "./director.js";

/**
 * **Import-boundary guards** — the comic ⇄ director cycle discipline, enforced.
 * `comic.ts` imports `DirectorMessageSchema` (a VALUE) from `director.ts`, so any
 * value import from `comic.ts` in `director.ts` closes a runtime cycle. The
 * failure mode is SILENT: ESM happily hoists the cycle and the module evaluates
 * with `undefined` enum bindings until something dereferences them mid-schema
 * build — typecheck and even a plain import can both pass. So the boundary is
 * pinned statically here (read the sources) AND probed at runtime (parse a plan
 * change below): if the static guard is ever bypassed, the undefined bindings
 * fail this test at import/parse time instead of shipping.
 */

/** Read one sibling source file (tests run from source, so it's always there). */
const src = (name: string) => readFileSync(new URL(name, import.meta.url), "utf8");

/** All `import ... from "<specifier>"` statements with whether they are type-only. */
function importsOf(source: string): { specifier: string; typeOnly: boolean }[] {
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const out: { specifier: string; typeOnly: boolean }[] = [];
  for (const m of stripped.matchAll(/import\s+(type\s+)?(?:\{[^}]*\}|\w+|\*\s+as\s+\w+)\s+from\s*["']([^"']+)["']/g)) {
    out.push({ typeOnly: !!m[1], specifier: m[2]! });
  }
  return out;
}

describe("import boundaries (no comic ⇄ director runtime cycle)", () => {
  it("episode.ts stays a leaf — sibling imports there would rebuild the cycle it exists to break", () => {
    const specs = importsOf(src("./episode.ts")).map((i) => i.specifier);
    expect(specs).toEqual(["zod"]);
  });

  it("director.ts imports from comic.ts TYPE-ONLY (values would close the runtime cycle)", () => {
    const fromComic = importsOf(src("./director.ts")).filter((i) => i.specifier === "./comic.js");
    expect(fromComic.length).toBeGreaterThan(0); // the type imports must exist…
    expect(fromComic.every((i) => i.typeOnly)).toBe(true); // …and all of them are type-only
  });

  it("comic.ts re-exports the episode vocabulary (its public home for consumers)", () => {
    expect(src("./comic.ts")).toMatch(/export\s+\*\s+from\s+["']\.\/episode\.js["']/);
  });

  it("runtime probe: the director contract still evaluates with live enum bindings", () => {
    // Dereferences EPISODE_STRUCTURES/FRAME_ROLES/GUTTER_TYPES inside
    // DirectorChangeSchema — all `undefined` if a cycle ever sneaks back in.
    const parsed = DirectorChangeSchema.parse({
      op: "updateFrame",
      frameIndex: 1,
      role: "turn",
      gutter: "action",
    });
    expect(parsed).toMatchObject({ op: "updateFrame", role: "turn", gutter: "action" });
    expect(DirectorChangeSchema.safeParse({ op: "updatePlan", structure: "nope" }).success).toBe(
      false,
    );
  });
});
