import { describe, expect, it } from "vitest";
import {
  CharacterStudySchema,
  MAX_STUDY_CHARACTER_REFS,
  STUDY_BASE_NEGATIVE,
  StudyCategory,
  compileStudyRefine,
  compileStudyRun,
  composeStudyPrompt,
  mergeStudies,
  studyIdFromNodeId,
  studyNegative,
  studyNodeId,
  studyReferences,
  type CharacterStudy,
  type StudyCharacterIdentity,
} from "./study.js";

const h = (c: string) => c.repeat(64);

const yue: StudyCharacterIdentity = {
  name: "Yue",
  description: "an exiled moon-goddess in rabbit form, jade eyes, silver fur",
  palette: ["#c9d8e0", "jade"],
  refHashes: [h("a"), h("b"), h("c"), h("d"), h("e"), h("f")],
};

const study = (over: Partial<CharacterStudy> & { id: string }): CharacterStudy =>
  CharacterStudySchema.parse(over);

describe("composeStudyPrompt", () => {
  it("leads with the brief, frames it as the category study, and locks identity", () => {
    const p = composeStudyPrompt(StudyCategory.Pose, "leaping mid-air", yue);
    const paragraphs = p.split("\n\n");
    expect(paragraphs[0]).toBe("leaping mid-air");
    expect(paragraphs[1]).toContain("full-body pose");
    expect(p).toContain("Character: Yue — an exiled moon-goddess");
    expect(p).toContain("Color palette:");
    expect(p).toContain("CHARACTER IDENTITY"); // compose-mode reference directive
  });

  it("omits directives with nothing behind them", () => {
    const p = composeStudyPrompt(
      StudyCategory.Symbol,
      "crescent sigil",
      { name: "", description: "", palette: [], refHashes: [] },
      undefined,
      false,
    );
    expect(p).not.toContain("Character:");
    expect(p).not.toContain("Color palette:");
    expect(p).not.toContain("Reference images:");
  });

  it("folds the style pack theme in as a Style: line", () => {
    const p = composeStudyPrompt(StudyCategory.Pose, "x", yue, { theme: "ink wash" });
    expect(p).toContain("Style: ink wash");
  });
});

describe("studyReferences / studyNegative", () => {
  it("caps character refs and appends style anchors, deduped, identity first", () => {
    const refs = studyReferences(yue, { anchors: [{ hash: h("a"), weight: 0.5 }, { hash: h("z"), weight: 0.7 }] });
    expect(refs.map((r) => r.hash)).toEqual([
      h("a"),
      h("b"),
      h("c"),
      h("d"), // MAX_STUDY_CHARACTER_REFS = 4, most-distinctive first
      h("z"), // style anchor appended; duplicate h("a") kept its identity slot
    ]);
    expect(refs).toHaveLength(MAX_STUDY_CHARACTER_REFS + 1);
    expect(refs[0]!.weight).toBe(1);
  });

  it("always bans text; keeps the pack's medium negative when present", () => {
    expect(studyNegative()).toBe(STUDY_BASE_NEGATIVE);
    expect(studyNegative("photographic, 3d render")).toBe(
      `photographic, 3d render, ${STUDY_BASE_NEGATIVE}`,
    );
  });
});

describe("studyNodeId", () => {
  it("round-trips generation slots and the refine slot", () => {
    expect(studyIdFromNodeId(studyNodeId("ab12cd34", 0))).toBe("ab12cd34");
    expect(studyIdFromNodeId(studyNodeId("ab12cd34", 3))).toBe("ab12cd34");
    expect(studyIdFromNodeId(studyNodeId("ab12cd34", "edit"))).toBe("ab12cd34");
    expect(studyIdFromNodeId("gen-frame1")).toBeUndefined();
  });
});

describe("compileStudyRun", () => {
  it("emits one node per take with consecutive seeds and category dimensions", () => {
    const graph = compileStudyRun({
      characterId: "c1",
      studyId: "s1",
      category: StudyCategory.Turnaround,
      prompt: "neutral stance",
      character: yue,
      modelId: "fal/test",
      count: 3,
      seed: 100,
    });
    expect(graph.nodes).toHaveLength(3);
    expect(graph.nodes.map((n) => n.id)).toEqual(["study-s1-v0", "study-s1-v1", "study-s1-v2"]);
    expect(graph.nodes.map((n) => n.params.seed)).toEqual([100, 101, 102]);
    expect(graph.nodes[0]!.params.width).toBe(1344); // turnaround is landscape
    expect(graph.nodes[0]!.params.height).toBe(768);
    expect(graph.nodes[0]!.params.references).toHaveLength(MAX_STUDY_CHARACTER_REFS);
  });

  it("applies the character LoRA before the pack's", () => {
    const graph = compileStudyRun({
      characterId: "c1",
      studyId: "s1",
      category: StudyCategory.Pose,
      prompt: "x",
      character: yue,
      pack: { theme: "", negative: "", anchors: [], loras: [{ path: "style.safetensors", scale: 1, name: "" }] },
      lora: { path: "yue.safetensors", scale: 1, name: "Yue" },
      modelId: "fal/test",
      count: 1,
      seed: 1,
    });
    expect(graph.nodes[0]!.params.loras).toEqual([
      { path: "yue.safetensors", scale: 1 },
      { path: "style.safetensors", scale: 1 },
    ]);
  });
});

describe("compileStudyRefine", () => {
  it("leads with the base image and keeps identity refs behind it", () => {
    const graph = compileStudyRefine({
      characterId: "c1",
      studyId: "s1",
      category: StudyCategory.Expression,
      baseHash: h("9"),
      instruction: "soften the eyes",
      mode: "tweak",
      character: yue,
      modelId: "fal/test",
      seed: 7,
    });
    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0]!.id).toBe("study-s1-edit");
    const refs = graph.nodes[0]!.params.references as { hash: string }[];
    expect(refs[0]!.hash).toBe(h("9"));
    expect(refs).toHaveLength(1 + MAX_STUDY_CHARACTER_REFS);
    expect(graph.nodes[0]!.params.prompt).toContain("soften the eyes");
    expect(graph.nodes[0]!.params.prompt).toContain("change ONLY what is described");
  });
});

describe("mergeStudies", () => {
  const v = (c: string, seed = 1) => ({ hash: h(c), seed });

  it("keeps server-side studies a stale snapshot omits (deletes only via DELETE)", () => {
    const server = [study({ id: "s1" }), study({ id: "s2" })];
    const merged = mergeStudies(server, [study({ id: "s2", title: "renamed" })]);
    expect(merged.map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(merged[1]!.title).toBe("renamed");
  });

  it("union-merges variants so a mid-flight generation survives a stale PUT", () => {
    const server = [study({ id: "s1", variants: [v("a"), v("b")], resultHash: h("b") })];
    const stale = [study({ id: "s1", variants: [v("a")], resultHash: h("a") })];
    const merged = mergeStudies(server, stale);
    expect(merged[0]!.variants.map((x) => x.hash)).toEqual([h("a"), h("b")]);
    // The stale selection is still a valid user choice — it wins.
    expect(merged[0]!.resultHash).toBe(h("a"));
  });

  it("repairs a selection that no longer exists in the merged history", () => {
    const server = [study({ id: "s1", variants: [v("a")], resultHash: h("a") })];
    const incoming = [study({ id: "s1", variants: [v("a")], resultHash: h("z") })];
    expect(mergeStudies(server, incoming)[0]!.resultHash).toBe(h("a"));
  });

  it("appends client-created studies awaiting their first run", () => {
    const merged = mergeStudies([study({ id: "s1" })], [study({ id: "s1" }), study({ id: "s9", prompt: "new" })]);
    expect(merged.map((s) => s.id)).toEqual(["s1", "s9"]);
  });
});
