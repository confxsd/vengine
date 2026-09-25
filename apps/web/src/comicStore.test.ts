import { describe, it, expect } from "vitest";
import {
  ComicCharacterSchema,
  DraftParseSchema,
  EpisodePlanSchema,
  type ComicCharacter,
  type ComicFrame,
} from "@vengine/shared";
import { draftToFrames } from "./comicStore";

/**
 * The apply path (`draftToFrames`, spec EPISODE_STUDIO §6) — the one place a
 * parsed draft becomes frame documents, so plan/role/gutter/echo mapping and the
 * §3.3 reconciliation are pinned against the real client code the DraftModal
 * drives. (`ingest-story.ts` mirrors it field-for-field for the server script.)
 */

const cast: ComicCharacter[] = [
  ComicCharacterSchema.parse({ id: "bruce", name: "Bruce", aliases: ["batman"] }),
  ComicCharacterSchema.parse({ id: "selina", name: "Selina" }),
];

const plannedParse = (frames: Record<string, unknown>[], plan: Record<string, unknown> = {}) =>
  DraftParseSchema.parse({
    plan: { structure: "kishotenketsu", theme: "vanity", motif: "the cracked mirror", ...plan },
    story: "a night of mirrors",
    frames,
  });

describe("draftToFrames — apply-path mapping (EPISODE_STUDIO §6)", () => {
  it("maps the plan onto the project and defaults every beat's role from the slot map", () => {
    const frames = draftToFrames(
      plannedParse([
        { prompt: "the bar, mirrored wall" },
        { prompt: "the tale begins" },
        { prompt: "the twist" },
        { prompt: "the landing" },
      ]),
      cast,
    );
    expect(frames.map((f) => f.role)).toEqual(["establish", "develop", "turn", "settle"]);
  });

  it("an explicit beat role wins over the slot map; gutters only land on beats 2+", () => {
    const frames = draftToFrames(
      plannedParse([
        { prompt: "first", role: "develop", gutter: "moment" }, // stale gutter: dropped
        { prompt: "second", gutter: "action" },
      ]),
      cast,
    );
    expect(frames[0]!.role).toBe("develop"); // the model's call stands
    expect(frames[0]!.gutter).toBeUndefined(); // no predecessor → meaningless
    expect(frames[1]!.gutter).toBe("action");
  });

  it("an echo (or continuity) index is applied only when strictly earlier; forward junk drops", () => {
    const frames = draftToFrames(
      plannedParse([
        { prompt: "opening" },
        { prompt: "middle", continues: 5 },
        { prompt: "close", echo: 0, continues: 9 },
      ]),
      cast,
    );
    expect(frames[1]!.continuesFrameId).toBeUndefined();
    expect(frames[2]!.echoFrameId).toBe(frames[0]!.id);
    expect(frames[2]!.continuesFrameId).toBeUndefined();
  });

  it("a parse with no plan lands roles unset — old parses compose unchanged", () => {
    const parse = DraftParseSchema.parse({ story: "s", frames: [{ prompt: "a" }, { prompt: "b" }] });
    const frames = draftToFrames(parse, cast);
    expect(frames.every((f) => f.role === undefined)).toBe(true);
  });

  it("reconciliation runs at apply: linking gutters auto-link, scene breaks, the framed-tale return survives", () => {
    const frames = draftToFrames(
      plannedParse([
        { prompt: "p1" },
        { prompt: "p2", gutter: "action" }, // auto-links to p1
        { prompt: "p3", gutter: "scene" }, // no continuity ref
        { prompt: "p4", gutter: "action", continues: 0 }, // the explicit return keeps p1
      ]),
      cast,
    );
    expect(frames[1]!.continuesFrameId).toBe(frames[0]!.id);
    expect(frames[2]!.continuesFrameId).toBeUndefined();
    expect(frames[3]!.continuesFrameId).toBe(frames[0]!.id);
  });

  it("character names map through aliases; unmatched names are dropped", () => {
    const frames = draftToFrames(
      plannedParse([{ prompt: "x", characters: ["Batman", "Selina", "Nobody"] }]),
      cast,
    );
    expect(frames[0]!.characterIds).toEqual(["bruce", "selina"]);
  });
});
