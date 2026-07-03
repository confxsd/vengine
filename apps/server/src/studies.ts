import { randomUUID } from "node:crypto";
import type { Hono } from "hono";
import { z } from "zod";
import {
  CharacterStudySchema,
  MAX_STUDY_BATCH,
  STUDY_CATEGORY_VALUES,
  TrainingStatus,
  compileStudyRefine,
  compileStudyRun,
  studyNodeId,
  type CharacterStudy,
  type ComicLora,
  type Library,
  type LibraryCharacter,
  type NodeProgressEvent,
  type StudyStyleSource,
} from "@vengine/shared";
import type { Runtime } from "./runtime.js";

type Broadcast = (event: NodeProgressEvent & { kind?: string }) => void;

const shortId = () => randomUUID().slice(0, 8);

/** A fresh random seed for an unlocked run — explores instead of cache-hitting. */
const rollSeed = () => Math.floor(Math.random() * 2_147_483_647);

/**
 * Generate variants for one study. `studyId` is client-authored (the client shows
 * the study optimistically and routes WS previews by it before the response
 * lands); the study record is persisted BEFORE the run starts, so a crash or a
 * mid-run refresh never orphans the exploration.
 */
const GenerateBody = z.object({
  studyId: z.string().min(1),
  category: z.enum(STUDY_CATEGORY_VALUES),
  title: z.string().default(""),
  prompt: z.string().min(1),
  modelId: z.string().min(1),
  styleId: z.string().default(""),
  count: z.number().int().min(1).max(MAX_STUDY_BATCH).default(2),
  seed: z.number().int().optional(),
  quality: z.enum(["preview", "final"]).optional(),
});

/** Refine one study image in place (instruction-driven image-to-image). */
const RefineBody = z.object({
  baseHash: z.string().length(64),
  instruction: z.string().min(1),
  mode: z.enum(["tweak", "restage"]).default("tweak"),
  modelId: z.string().min(1),
  seed: z.number().int().optional(),
  quality: z.enum(["preview", "final"]).optional(),
});

/** User-editable study fields (curation — never the generation outputs). */
const StudyPatchBody = CharacterStudySchema.pick({
  title: true,
  notes: true,
  prompt: true,
  category: true,
  starred: true,
  resultHash: true,
  styleId: true,
}).partial();

/** Resolve the style-pack subset a study run consumes ("" / unknown id → none). */
function packFor(lib: Library, styleId: string): StudyStyleSource | undefined {
  const pack = styleId ? lib.styles.find((s) => s.id === styleId) : undefined;
  if (!pack) return undefined;
  return { theme: pack.theme, negative: pack.negative, anchors: pack.anchors, loras: pack.loras };
}

/** The character's ready subject LoRA, if it has one. */
function loraFor(lib: Library, character: LibraryCharacter): ComicLora | undefined {
  const lora = character.loraId
    ? lib.trainedLoras.find((t) => t.id === character.loraId)
    : undefined;
  if (!lora || lora.status !== TrainingStatus.Ready || !lora.loraUrl) return undefined;
  return { path: lora.loraUrl, scale: 1, name: lora.name };
}

/**
 * Mount the **Character System** routes: per-character design-study generation,
 * refine, curation (patch/select/star) and deletion. Shares the comic run
 * plumbing — runId + the common cancel registry, "*" bracket events, WS preview
 * routing by node id — so study generations stream and cancel exactly like
 * frames. All persistence goes through the LibraryStore's locked study
 * primitives, so a run's write-back never races a user edit.
 */
export function registerStudyRoutes(
  app: Hono,
  rt: Runtime,
  broadcast: Broadcast,
  runs: Map<string, AbortController>,
): void {
  /** Run a compiled study graph with the shared cancel/bracket plumbing and
   *  collect each node's produced image hash (streamed hashes as fallback, so a
   *  cancelled run still persists what finished). */
  const runStudyGraph = async (
    graph: ReturnType<typeof compileStudyRun>,
    nodeIds: string[],
    quality: "preview" | "final" | undefined,
  ) => {
    const runId = randomUUID();
    const ac = new AbortController();
    runs.set(runId, ac);
    broadcast({ runId, nodeId: "*", status: "running", at: new Date().toISOString() });

    const produced = new Map<string, string>();
    const wanted = new Set(nodeIds);
    let result;
    try {
      result = await rt.executor.run(graph, {
        runId,
        services: rt.services,
        quality,
        emit: (e) => {
          if (wanted.has(e.nodeId) && e.previewHash) produced.set(e.nodeId, e.previewHash);
          broadcast(e);
        },
        signal: ac.signal,
      });
    } finally {
      runs.delete(runId);
    }

    // Prefer the authoritative run result; keep streamed hashes for early stops.
    for (const nodeId of nodeIds) {
      const hash = (result.nodes.get(nodeId)?.outputs?.image as { hash?: string } | undefined)
        ?.hash;
      if (hash) produced.set(nodeId, hash);
    }

    broadcast({
      runId,
      nodeId: "*",
      status: result.status === "done" ? "done" : "error",
      error: result.error,
      at: new Date().toISOString(),
    });
    return { result, produced };
  };

  // Generate N variants into a (new or existing) study.
  app.post("/api/library/characters/:id/studies/generate", async (c) => {
    const characterId = c.req.param("id");
    const parsed = GenerateBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const req = parsed.data;

    const lib = await rt.library.get();
    const character = lib.characters.find((x) => x.id === characterId);
    if (!character) return c.json({ error: "character not found" }, 404);

    // Persist the study (create or update its brief) BEFORE running, so the
    // record exists while images stream and survives a restart mid-run.
    const existing = character.studies.find((s) => s.id === req.studyId);
    const study: CharacterStudy = CharacterStudySchema.parse({
      ...(existing ?? { id: req.studyId }),
      category: req.category,
      title: req.title || existing?.title || "",
      prompt: req.prompt,
      styleId: req.styleId,
    });
    if (!(await rt.library.upsertStudy(characterId, study))) {
      return c.json({ error: "character not found" }, 404);
    }

    const seed = req.seed ?? rollSeed();
    const graph = compileStudyRun({
      characterId,
      studyId: study.id,
      category: study.category,
      prompt: study.prompt,
      character,
      pack: packFor(lib, req.styleId),
      lora: loraFor(lib, character),
      modelId: req.modelId,
      count: req.count,
      seed,
    });
    const nodeIds = Array.from({ length: req.count }, (_, i) => studyNodeId(study.id, i));
    const { result, produced } = await runStudyGraph(graph, nodeIds, req.quality);

    const variants = nodeIds.flatMap((nodeId, i) => {
      const hash = produced.get(nodeId);
      return hash ? [{ hash, seed: seed + i }] : [];
    });
    const saved = await rt.library.appendStudyVariants(characterId, study.id, variants);

    return c.json({
      runId: result.runId,
      status: result.status,
      error: result.error,
      studyId: study.id,
      character: saved ?? null,
    });
  });

  // Refine one study image in place; the result lands as a new selected variant.
  app.post("/api/library/characters/:id/studies/:studyId/refine", async (c) => {
    const characterId = c.req.param("id");
    const studyId = c.req.param("studyId");
    const parsed = RefineBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const req = parsed.data;

    const lib = await rt.library.get();
    const character = lib.characters.find((x) => x.id === characterId);
    const study = character?.studies.find((s) => s.id === studyId);
    if (!character || !study) return c.json({ error: "study not found" }, 404);

    const seed = req.seed ?? rollSeed();
    const graph = compileStudyRefine({
      characterId,
      studyId,
      category: study.category,
      baseHash: req.baseHash,
      instruction: req.instruction,
      mode: req.mode,
      character,
      pack: packFor(lib, study.styleId),
      lora: loraFor(lib, character),
      modelId: req.modelId,
      seed,
    });
    const nodeId = studyNodeId(studyId, "edit");
    const { result, produced } = await runStudyGraph(graph, [nodeId], req.quality);

    const hash = produced.get(nodeId);
    const saved = hash
      ? await rt.library.appendStudyVariants(characterId, studyId, [{ hash, seed }])
      : await rt.library.updateStudy(characterId, studyId, (s) => s);

    return c.json({
      runId: result.runId,
      status: result.status,
      error: result.error,
      studyId,
      character: saved ?? null,
    });
  });

  // Curate one study: rename, notes, re-shelve, star, select a variant.
  app.patch("/api/library/characters/:id/studies/:studyId", async (c) => {
    const parsed = StudyPatchBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const patch = parsed.data;
    const saved = await rt.library.updateStudy(
      c.req.param("id"),
      c.req.param("studyId"),
      (s) => {
        const next = { ...s, ...patch };
        // A selection must point at an image the study actually has.
        if (patch.resultHash && !s.variants.some((v) => v.hash === patch.resultHash)) {
          next.resultHash = s.resultHash;
        }
        return next;
      },
    );
    if (!saved) return c.json({ error: "study not found" }, 404);
    return c.json(saved);
  });

  // Delete one study (the only path that removes one — see mergeStudies).
  app.delete("/api/library/characters/:id/studies/:studyId", async (c) => {
    const saved = await rt.library.removeStudy(c.req.param("id"), c.req.param("studyId"));
    if (!saved) return c.json({ error: "character not found" }, 404);
    return c.json(saved);
  });

  // Delete one generated variant from a study.
  app.delete("/api/library/characters/:id/studies/:studyId/variants/:hash", async (c) => {
    const saved = await rt.library.removeStudyVariant(
      c.req.param("id"),
      c.req.param("studyId"),
      c.req.param("hash"),
    );
    if (!saved) return c.json({ error: "study not found" }, 404);
    return c.json(saved);
  });
}
