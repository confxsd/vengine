import { create } from "zustand";
import { toast } from "sonner";
import {
  composeFramePrompt,
  frameIdFromNodeId,
  styleReferences,
  DEFAULT_REFERENCE_WEIGHT,
  type ComicCharacter,
  type ComicLora,
  type ComicFrame,
  type ComicProject,
  type ComicReference,
  type ComicStyle,
  type ComicVariant,
} from "@vengine/shared";
import { api, connectProgress } from "./api";
import type { ModelInfo, NodeProgressEvent, NodeRunStatus, ProjectSummary, RunPlan } from "./types";

/** Collision-resistant frame id (node ids + cache keys derive from it). */
const newFrameId = () => crypto.randomUUID().slice(0, 8);
/** Collision-resistant character id (frames reference it via `characterIds`). */
const newCharId = () => crypto.randomUUID().slice(0, 8);
const randomSeed = () => Math.floor(Math.random() * 1_000_000);

type SaveState = "idle" | "saving" | "saved" | "error";

interface ComicState {
  projects: ProjectSummary[];
  project: ComicProject | null;
  models: ModelInfo[];
  /** Whether the server has a text model + API key wired (gates the AI buttons). */
  assistAvailable: boolean;
  quality: "preview" | "final";
  running: boolean;
  /** Id of the in-flight run, learned from the WS start event; enables cancel. */
  activeRunId: string | null;
  plan: RunPlan | null;
  saveState: SaveState;
  status: string;
  /** Live per-frame run status, keyed by frame id (transient, cleared after a run). */
  liveStatus: Record<string, NodeRunStatus>;
  /** Live preview hashes streamed during a run (override the selection while running). */
  livePreview: Record<string, string>;

  init: () => Promise<void>;
  loadProject: (id: string) => Promise<void>;
  createProject: (name?: string) => Promise<void>;

  setName: (name: string) => void;
  setStory: (story: string) => void;
  setSettings: (settings: string) => void;
  setTemplate: (template: string) => void;
  patchStyle: (patch: Partial<ComicStyle>) => void;

  addFrame: () => void;
  removeFrame: (id: string) => void;
  /** Delete one generated image from a frame's history (server-authoritative). */
  removeVariant: (frameId: string, hash: string) => Promise<void>;
  patchFrame: (id: string, patch: Partial<ComicFrame>) => void;
  moveFrame: (id: string, dir: -1 | 1) => void;
  /** Link a frame as a continuation of another frame's scene (null clears it). */
  setFrameContinuation: (frameId: string, sourceId: string | null) => void;

  selectVariant: (frameId: string, variant: ComicVariant) => void;
  varyFrame: (id: string) => Promise<void>;

  // Multiple weighted style references (the look anchors fed to every frame)
  uploadStyleRef: (file: File) => Promise<void>;
  addStyleRefFromFrame: (id: string) => void;
  addStyleRefFromLibrary: (hash: string) => void;
  setStyleRefWeight: (hash: string, weight: number) => void;
  removeStyleRef: (hash: string) => void;
  clearStyleRefs: () => void;

  // Reusable reference library — bank an image once, attach it anywhere
  renameLibraryAsset: (hash: string, label: string) => void;
  removeLibraryAsset: (hash: string) => void;

  // Cast / character consistency
  addCharacter: () => void;
  removeCharacter: (id: string) => void;
  patchCharacter: (id: string, patch: Partial<ComicCharacter>) => void;
  uploadCharacterRef: (charId: string, file: File) => Promise<void>;
  /** Use a frame's current image as an identity reference (the "character sheet" shortcut). */
  addCharacterRefFromFrame: (charId: string, frameId: string) => void;
  /** Attach an already-banked library image as an identity reference. */
  addCharacterRefFromLibrary: (charId: string, hash: string) => void;
  removeCharacterRef: (charId: string, hash: string) => void;
  /** Toggle whether a cast member appears in a frame (tri-state: undefined = whole cast). */
  toggleFrameCharacter: (frameId: string, charId: string) => void;

  // House-style LoRAs
  addLora: () => void;
  patchLora: (index: number, patch: Partial<ComicLora>) => void;
  removeLora: (index: number) => void;

  setQuality: (q: "preview" | "final") => void;
  doPlan: () => Promise<void>;
  runAll: () => Promise<void>;
  runOne: (id: string) => Promise<void>;
  cancelRun: () => Promise<void>;
  snapshot: () => Promise<void>;

  /** The image to display for a frame: live preview → selection → newest variant. */
  displayHash: (frame: ComicFrame) => string | undefined;
  /** Final composed prompt for a frame — identical to what the server compiles. */
  finalPrompt: (frame: ComicFrame) => string;
}

let initialized = false;
let debounceTimer: ReturnType<typeof setTimeout> | undefined;
/** Serial save tail: every save waits for the previous one, so PUTs never race. */
let saveTail: Promise<void> = Promise.resolve();
/** An edit happened during a run; flush it once the run finishes (saves are
 *  deferred while running so a client PUT can't clobber the run's write-back). */
let dirtyDuringRun = false;

export const useComic = create<ComicState>((set, get) => {
  /** Persist the latest project, serialized behind any in-flight save. Sends the
   *  full document: the server union-merges `variants` and never overwrites a
   *  `resultHash` with undefined, and `resultHash` carries the current selection. */
  const queueSave = (): Promise<void> => {
    saveTail = saveTail.then(async () => {
      const project = get().project;
      if (!project) return;
      set({ saveState: "saving" });
      try {
        await api.saveComic(project);
        set({ saveState: "saved" });
      } catch (err) {
        set({ saveState: "error" });
        toast.error("Couldn't save", { description: (err as Error).message });
      }
    }, () => undefined);
    return saveTail;
  };

  const scheduleSave = () => {
    if (get().running) {
      dirtyDuringRun = true; // defer until the run's write-back lands
      return;
    }
    if (debounceTimer) clearTimeout(debounceTimer);
    set({ saveState: "saving" });
    debounceTimer = setTimeout(() => void queueSave(), 600);
  };

  /** Apply a pure update to the current project, then schedule a debounced save. */
  const mutate = (fn: (p: ComicProject) => ComicProject) => {
    const current = get().project;
    if (!current) return;
    set({ project: fn(current) });
    scheduleSave();
  };

  /** Add an image to the reusable library (idempotent by hash). All upload/bank
   *  flows route through here so the library stays the single pool of references. */
  const bankAsset = (p: ComicProject, hash: string, label = ""): ComicProject =>
    p.library.some((a) => a.hash === hash)
      ? p
      : { ...p, library: [...p.library, { hash, label }] };

  /** Mutate the weighted style-reference list. Bases every write on
   *  `styleReferences` (so a legacy single `anchorHash` is migrated on first edit)
   *  and clears `anchorHash` so `anchors` becomes the single source of truth. */
  const mutateAnchors = (fn: (refs: ComicReference[]) => ComicReference[]) =>
    mutate((p) => ({
      ...p,
      style: { ...p.style, anchors: fn(styleReferences(p.style)), anchorHash: undefined },
    }));

  /** Bank a hash into the library and attach it as a style reference (idempotent). */
  const bankAndAddStyleRef = (hash: string, label = "") => {
    mutate((p) => bankAsset(p, hash, label));
    mutateAnchors((refs) =>
      refs.some((r) => r.hash === hash)
        ? refs
        : [...refs, { hash, weight: DEFAULT_REFERENCE_WEIGHT }],
    );
  };

  const refreshList = async () => {
    try {
      set({ projects: await api.comics() });
    } catch {
      /* non-fatal: the switcher just shows slightly stale metadata */
    }
  };

  /** Run a set of frames: persist edits, mark queued, POST, adopt the result. */
  const runFrames = async (frameIds: string[]): Promise<void> => {
    const p = get().project;
    if (!p || get().running || frameIds.length === 0) return;

    // Persist current edits first (serialized) so the server compiles them.
    if (debounceTimer) clearTimeout(debounceTimer);
    await queueSave();

    const queued: Record<string, NodeRunStatus> = {};
    for (const id of frameIds) queued[id] = "queued";
    set({ running: true, plan: null, liveStatus: queued, livePreview: {}, status: "generating…" });

    try {
      const result = await api.runComic(p.id, get().quality, frameIds);
      // Adopt authoritative outputs (resultHash + variants) onto the current
      // in-memory project, preserving prompt/seed edits made during the run.
      const byId = new Map(result.frames.map((f) => [f.id, f]));
      const project = get().project;
      if (project) {
        set({
          project: {
            ...project,
            frames: project.frames.map((f) => {
              const r = byId.get(f.id);
              return r ? { ...f, resultHash: r.resultHash, variants: r.variants } : f;
            }),
          },
        });
      }
      if (result.status === "done") {
        set({ status: `done ✓ · ${frameIds.length} frame(s)` });
      } else {
        set({ status: `run ${result.status}` });
        if (result.status === "error") toast.error("Run failed", { description: result.error });
      }
    } catch (err) {
      toast.error("Run failed", { description: (err as Error).message });
      set({ status: `error: ${(err as Error).message}` });
    } finally {
      set({ running: false, activeRunId: null, liveStatus: {}, livePreview: {} });
      if (dirtyDuringRun) {
        dirtyDuringRun = false;
        void queueSave();
      }
    }
  };

  /** Route a live WS progress event to its frame (only for the active run). */
  const applyProgress = (e: NodeProgressEvent): void => {
    if (!e.nodeId) return;
    // The "*" sentinel brackets a run: capture its id (for cancel) on start.
    if (e.nodeId === "*") {
      if (e.status === "running") set({ activeRunId: e.runId });
      return;
    }
    // Ignore events outside an active run (stale/late) or for a foreign frame.
    if (!get().running) return;
    const frameId = frameIdFromNodeId(e.nodeId);
    if (!frameId) return;
    const project = get().project;
    if (!project || !project.frames.some((f) => f.id === frameId)) return;

    const liveStatus = { ...get().liveStatus };
    const livePreview = { ...get().livePreview };
    if (e.nodeId.startsWith("gen-")) liveStatus[frameId] = e.status;
    if (e.previewHash) livePreview[frameId] = e.previewHash;
    set({ liveStatus, livePreview });
  };

  return {
    projects: [],
    project: null,
    models: [],
    assistAvailable: false,
    quality: "final",
    running: false,
    activeRunId: null,
    plan: null,
    saveState: "idle",
    status: "ready",
    liveStatus: {},
    livePreview: {},

    init: async () => {
      if (initialized) return; // a remount must not open a second WS / reseed
      initialized = true;
      try {
        const [models, projects] = await Promise.all([api.models(), api.comics()]);
        set({ models, projects });
        const first = projects[0];
        if (first) await get().loadProject(first.id);
        else await get().createProject("My first comic");
      } catch (err) {
        initialized = false;
        toast.error("Couldn't load Comic Studio", { description: (err as Error).message });
        return;
      }
      // Single WS subscription for the app lifetime (re-entry is blocked above).
      connectProgress(applyProgress);
      // Probe AI assist availability (non-fatal: button just stays hidden if off).
      api
        .assistConfig()
        .then((cfg) => set({ assistAvailable: cfg.available }))
        .catch(() => undefined);
    },

    loadProject: async (id) => {
      const project = await api.comic(id);
      set({ project, plan: null, liveStatus: {}, livePreview: {}, saveState: "saved", status: "ready" });
    },

    createProject: async (name) => {
      const project = await api.createComic(name);
      set({ project, plan: null, liveStatus: {}, livePreview: {}, saveState: "saved", status: "ready" });
      await refreshList();
    },

    setName: (name) => mutate((p) => ({ ...p, name })),
    setStory: (story) => mutate((p) => ({ ...p, story })),
    setSettings: (settings) => mutate((p) => ({ ...p, settings })),
    setTemplate: (promptTemplate) => mutate((p) => ({ ...p, promptTemplate })),
    patchStyle: (patch) => mutate((p) => ({ ...p, style: { ...p.style, ...patch } })),

    addFrame: () =>
      mutate((p) => ({ ...p, frames: [...p.frames, { id: newFrameId(), prompt: "", variants: [] }] })),
    // Drop the frame and clear any continuation links pointing at it, so no frame
    // is left referencing a deleted scene (compile ignores unknown ids regardless).
    removeFrame: (id) =>
      mutate((p) => ({
        ...p,
        frames: p.frames
          .filter((f) => f.id !== id)
          .map((f) => (f.continuesFrameId === id ? { ...f, continuesFrameId: undefined } : f)),
      })),
    patchFrame: (id, patch) =>
      mutate((p) => ({
        ...p,
        frames: p.frames.map((f) => (f.id === id ? { ...f, ...patch } : f)),
      })),
    setFrameContinuation: (frameId, sourceId) =>
      get().patchFrame(frameId, { continuesFrameId: sourceId ?? undefined }),
    moveFrame: (id, dir) =>
      mutate((p) => {
        const i = p.frames.findIndex((f) => f.id === id);
        const j = i + dir;
        if (i < 0 || j < 0 || j >= p.frames.length) return p;
        const frames = [...p.frames];
        const [moved] = frames.splice(i, 1);
        frames.splice(j, 0, moved!);
        return { ...p, frames };
      }),

    // Pick a past iteration: restores its image and the seed that made it, so a
    // subsequent run reproduces that look.
    selectVariant: (frameId, variant) =>
      get().patchFrame(frameId, { resultHash: variant.hash, seed: variant.seed }),

    // Explore: roll a fresh seed for this frame and regenerate it (adds a variant).
    varyFrame: async (id) => {
      get().patchFrame(id, { seed: randomSeed() });
      await runFrames([id]);
    },

    // Delete one image from a frame's history. Outputs are server-authoritative
    // (a plain save union-merges variants), so this goes through the dedicated
    // route. Flush pending edits first so a debounced save can't re-add it.
    removeVariant: async (frameId, hash) => {
      const p = get().project;
      if (!p) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      await queueSave();
      try {
        const delta = await api.deleteVariant(p.id, frameId, hash);
        const project = get().project;
        if (!project) return;
        set({
          project: {
            ...project,
            frames: project.frames.map((f) =>
              f.id === frameId ? { ...f, resultHash: delta.resultHash, variants: delta.variants } : f,
            ),
          },
        });
        toast.success("Image deleted");
      } catch (err) {
        toast.error("Couldn't delete image", { description: (err as Error).message });
      }
    },

    uploadStyleRef: async (file) => {
      try {
        const ref = await api.uploadAsset(file);
        bankAndAddStyleRef(ref.hash, file.name);
        toast.success("Style reference added");
      } catch (err) {
        toast.error("Upload failed", { description: (err as Error).message });
      }
    },
    addStyleRefFromFrame: (id) => {
      const frame = get().project?.frames.find((f) => f.id === id);
      const hash = frame ? get().displayHash(frame) : undefined;
      if (!hash) return;
      const already = styleReferences(get().project!.style).some((r) => r.hash === hash);
      bankAndAddStyleRef(hash);
      toast.success(already ? "Already a style reference" : "Style reference added from frame");
    },
    addStyleRefFromLibrary: (hash) => bankAndAddStyleRef(hash),
    setStyleRefWeight: (hash, weight) =>
      mutateAnchors((refs) => refs.map((r) => (r.hash === hash ? { ...r, weight } : r))),
    removeStyleRef: (hash) => mutateAnchors((refs) => refs.filter((r) => r.hash !== hash)),
    clearStyleRefs: () => mutateAnchors(() => []),

    renameLibraryAsset: (hash, label) =>
      mutate((p) => ({
        ...p,
        library: p.library.map((a) => (a.hash === hash ? { ...a, label } : a)),
      })),
    // Remove from the pool and detach every usage, so nothing dangles.
    removeLibraryAsset: (hash) =>
      mutate((p) => ({
        ...p,
        library: p.library.filter((a) => a.hash !== hash),
        style: {
          ...p.style,
          anchors: styleReferences(p.style).filter((r) => r.hash !== hash),
          anchorHash: undefined,
        },
        cast: p.cast.map((c) => ({ ...c, refHashes: c.refHashes.filter((h) => h !== hash) })),
      })),

    addCharacter: () =>
      mutate((p) => ({ ...p, cast: [...p.cast, { id: newCharId(), name: "", refHashes: [] }] })),

    // Drop the character and strip its id from any frame's explicit member list
    // (frames keep working regardless — unknown ids are ignored at compile — but
    // a tidy document avoids dangling references).
    removeCharacter: (id) =>
      mutate((p) => ({
        ...p,
        cast: p.cast.filter((c) => c.id !== id),
        frames: p.frames.map((f) =>
          f.characterIds ? { ...f, characterIds: f.characterIds.filter((cid) => cid !== id) } : f,
        ),
      })),

    patchCharacter: (id, patch) =>
      mutate((p) => ({
        ...p,
        cast: p.cast.map((c) => (c.id === id ? { ...c, ...patch } : c)),
      })),

    uploadCharacterRef: async (charId, file) => {
      try {
        const ref = await api.uploadAsset(file);
        const char = get().project?.cast.find((c) => c.id === charId);
        if (!char) return;
        mutate((p) => bankAsset(p, ref.hash, file.name)); // also bank to the reusable library
        if (!char.refHashes.includes(ref.hash))
          get().patchCharacter(charId, { refHashes: [...char.refHashes, ref.hash] });
        toast.success("Character reference added");
      } catch (err) {
        toast.error("Upload failed", { description: (err as Error).message });
      }
    },

    addCharacterRefFromFrame: (charId, frameId) => {
      const frame = get().project?.frames.find((f) => f.id === frameId);
      const hash = frame ? get().displayHash(frame) : undefined;
      const char = get().project?.cast.find((c) => c.id === charId);
      if (!hash || !char) return;
      mutate((p) => bankAsset(p, hash)); // banked frame outputs join the library too
      if (char.refHashes.includes(hash)) {
        toast("Already a reference for this character");
        return;
      }
      get().patchCharacter(charId, { refHashes: [...char.refHashes, hash] });
      toast.success(`Reference added to ${char.name.trim() || "character"}`);
    },

    addCharacterRefFromLibrary: (charId, hash) => {
      const char = get().project?.cast.find((c) => c.id === charId);
      if (!char) return;
      if (char.refHashes.includes(hash)) {
        toast("Already a reference for this character");
        return;
      }
      get().patchCharacter(charId, { refHashes: [...char.refHashes, hash] });
      toast.success(`Reference added to ${char.name.trim() || "character"}`);
    },

    removeCharacterRef: (charId, hash) => {
      const char = get().project?.cast.find((c) => c.id === charId);
      if (!char) return;
      get().patchCharacter(charId, { refHashes: char.refHashes.filter((h) => h !== hash) });
    },

    // Tri-state membership: materialize "whole cast" only when the artist first
    // excludes someone; re-normalize back to undefined once every member is on,
    // so a newly added character auto-appears in this frame.
    toggleFrameCharacter: (frameId, charId) => {
      const p = get().project;
      const frame = p?.frames.find((f) => f.id === frameId);
      if (!p || !frame) return;
      const allIds = p.cast.map((c) => c.id);
      const current = frame.characterIds ?? allIds;
      const next = current.includes(charId)
        ? current.filter((id) => id !== charId)
        : [...current, charId];
      const isWholeCast = next.length === allIds.length && allIds.every((id) => next.includes(id));
      get().patchFrame(frameId, { characterIds: isWholeCast ? undefined : next });
    },

    addLora: () =>
      get().patchStyle({ loras: [...(get().project?.style.loras ?? []), { path: "", scale: 1, name: "" }] }),
    patchLora: (index, patch) =>
      get().patchStyle({
        loras: (get().project?.style.loras ?? []).map((l, i) => (i === index ? { ...l, ...patch } : l)),
      }),
    removeLora: (index) =>
      get().patchStyle({ loras: (get().project?.style.loras ?? []).filter((_, i) => i !== index) }),

    setQuality: (quality) => set({ quality, plan: null }),

    doPlan: async () => {
      const p = get().project;
      if (!p) return;
      try {
        const plan = await api.planComic(p.id, get().quality);
        set({ plan, status: `plan: ${plan.willRunCount} run · ${plan.cachedCount} cached` });
      } catch (err) {
        toast.error("Estimate failed", { description: (err as Error).message });
      }
    },

    runAll: async () => runFrames(get().project?.frames.map((f) => f.id) ?? []),
    runOne: async (id) => runFrames([id]),

    cancelRun: async () => {
      const runId = get().activeRunId;
      if (!runId) return;
      await api.cancelRun(runId).catch(() => false);
      toast("Cancelling run…");
    },

    snapshot: async () => {
      const p = get().project;
      if (!p) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      await queueSave(); // capture the latest edits in the snapshot
      try {
        await api.snapshotComic(p.id);
        toast.success("Snapshot saved");
      } catch (err) {
        toast.error("Snapshot failed", { description: (err as Error).message });
      }
    },

    displayHash: (frame) =>
      get().livePreview[frame.id] ?? frame.resultHash ?? frame.variants.at(-1)?.hash,

    finalPrompt: (frame) => {
      const p = get().project;
      return p ? composeFramePrompt(p, frame) : frame.prompt;
    },
  };
});
