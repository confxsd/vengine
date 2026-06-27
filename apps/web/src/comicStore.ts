import { create } from "zustand";
import {
  composeFramePrompt,
  frameIdFromNodeId,
  type ComicFrame,
  type ComicProject,
  type ComicStyle,
} from "@vengine/shared";
import { api, connectProgress } from "./api";
import type { ModelInfo, NodeProgressEvent, NodeRunStatus, ProjectSummary, RunPlan } from "./types";

const shortId = () => Math.random().toString(36).slice(2, 10);

type SaveState = "idle" | "saving" | "saved" | "error";

interface ComicState {
  projects: ProjectSummary[];
  project: ComicProject | null;
  models: ModelInfo[];
  quality: "preview" | "final";
  running: boolean;
  plan: RunPlan | null;
  saveState: SaveState;
  status: string;
  /** Live per-frame run status, keyed by frame id (transient, cleared after a run). */
  liveStatus: Record<string, NodeRunStatus>;
  /** Live preview hashes streamed during a run (override resultHash while running). */
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
  patchFrame: (id: string, patch: Partial<ComicFrame>) => void;
  moveFrame: (id: string, dir: -1 | 1) => void;

  uploadAnchor: (file: File) => Promise<void>;
  setAnchorFromFrame: (id: string) => void;
  clearAnchor: () => void;

  setQuality: (q: "preview" | "final") => void;
  doPlan: () => Promise<void>;
  runAll: () => Promise<void>;
  runOne: (id: string) => Promise<void>;
  snapshot: () => Promise<void>;

  /** Final composed prompt for a frame — identical to what the server compiles. */
  finalPrompt: (frame: ComicFrame) => string;
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;

export const useComic = create<ComicState>((set, get) => {
  /** Apply a pure update to the current project, then schedule a debounced save. */
  const mutate = (fn: (p: ComicProject) => ComicProject) => {
    const current = get().project;
    if (!current) return;
    set({ project: fn(current) });
    scheduleSave();
  };

  const scheduleSave = () => {
    if (saveTimer) clearTimeout(saveTimer);
    set({ saveState: "saving" });
    saveTimer = setTimeout(() => void flushSave(), 600);
  };

  const flushSave = async () => {
    const project = get().project;
    if (!project) return;
    try {
      // resultHash is server-authoritative; strip it so an autosave never
      // clobbers a hash written by a run (the store merges it back).
      const payload: ComicProject = {
        ...project,
        frames: project.frames.map(({ resultHash: _omit, ...f }) => f),
      };
      const saved = await api.saveComic(payload);
      set({ saveState: "saved" });
      // Refresh the switcher list metadata without disturbing the open project.
      void refreshList();
      return saved;
    } catch (err) {
      set({ saveState: "error", status: `save error: ${(err as Error).message}` });
    }
  };

  const refreshList = async () => {
    try {
      set({ projects: await api.comics() });
    } catch {
      /* non-fatal */
    }
  };

  return {
    projects: [],
    project: null,
    models: [],
    quality: "final",
    running: false,
    plan: null,
    saveState: "idle",
    status: "ready",
    liveStatus: {},
    livePreview: {},

    init: async () => {
      const [models, projects] = await Promise.all([api.models(), api.comics()]);
      set({ models, projects });

      const first = projects[0];
      if (first) {
        await get().loadProject(first.id);
      } else {
        await get().createProject("My first comic");
      }

      connectProgress((e) => applyProgress(set, get, e));
    },

    loadProject: async (id) => {
      const project = await api.comic(id);
      set({ project, plan: null, liveStatus: {}, livePreview: {}, saveState: "saved", status: "ready" });
    },

    createProject: async (name) => {
      const project = await api.createComic(name);
      await refreshList();
      set({ project, plan: null, liveStatus: {}, livePreview: {}, saveState: "saved", status: "ready" });
    },

    setName: (name) => mutate((p) => ({ ...p, name })),
    setStory: (story) => mutate((p) => ({ ...p, story })),
    setSettings: (settings) => mutate((p) => ({ ...p, settings })),
    setTemplate: (promptTemplate) => mutate((p) => ({ ...p, promptTemplate })),
    patchStyle: (patch) => mutate((p) => ({ ...p, style: { ...p.style, ...patch } })),

    addFrame: () => mutate((p) => ({ ...p, frames: [...p.frames, { id: shortId(), prompt: "" }] })),
    removeFrame: (id) => mutate((p) => ({ ...p, frames: p.frames.filter((f) => f.id !== id) })),
    patchFrame: (id, patch) =>
      mutate((p) => ({
        ...p,
        frames: p.frames.map((f) => (f.id === id ? { ...f, ...patch } : f)),
      })),
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

    uploadAnchor: async (file) => {
      set({ status: "uploading anchor…" });
      try {
        const ref = await api.uploadAsset(file);
        get().patchStyle({ anchorHash: ref.hash });
        set({ status: "anchor set ✓" });
      } catch (err) {
        set({ status: `upload error: ${(err as Error).message}` });
      }
    },
    setAnchorFromFrame: (id) => {
      const hash = get().project?.frames.find((f) => f.id === id)?.resultHash;
      if (hash) get().patchStyle({ anchorHash: hash });
    },
    clearAnchor: () => get().patchStyle({ anchorHash: undefined }),

    setQuality: (quality) => set({ quality, plan: null }),

    doPlan: async () => {
      const p = get().project;
      if (!p) return;
      try {
        const plan = await api.planComic(p.id, get().quality);
        set({ plan, status: `plan: ${plan.willRunCount} run · ${plan.cachedCount} cached` });
      } catch (err) {
        set({ status: `plan error: ${(err as Error).message}` });
      }
    },

    runAll: async () => {
      const ids = get().project?.frames.map((f) => f.id) ?? [];
      await runFrames(set, get, ids);
    },
    runOne: async (id) => {
      await runFrames(set, get, [id]);
    },

    snapshot: async () => {
      const p = get().project;
      if (!p) return;
      // Make sure the latest edits are persisted before snapshotting.
      if (saveTimer) clearTimeout(saveTimer);
      await flushSave();
      try {
        await api.snapshotComic(p.id);
        set({ status: "snapshot saved ✓" });
      } catch (err) {
        set({ status: `snapshot error: ${(err as Error).message}` });
      }
    },

    finalPrompt: (frame) => {
      const p = get().project;
      return p ? composeFramePrompt(p, frame) : frame.prompt;
    },
  };
});

/** Run a set of frames: flush pending edits, mark queued, POST, then merge results. */
async function runFrames(
  set: (partial: Partial<ComicState>) => void,
  get: () => ComicState,
  frameIds: string[],
): Promise<void> {
  const p = get().project;
  if (!p || get().running || frameIds.length === 0) return;

  // Persist edits first so the server compiles the current prompts.
  if (saveTimer) clearTimeout(saveTimer);
  try {
    await api.saveComic({ ...p, frames: p.frames.map(({ resultHash: _o, ...f }) => f) });
  } catch {
    /* run will still use last saved state */
  }

  const queued: Record<string, NodeRunStatus> = { ...get().liveStatus };
  for (const id of frameIds) queued[id] = "queued";
  set({ running: true, plan: null, liveStatus: queued, status: "running…" });

  try {
    const result = await api.runComic(p.id, get().quality, frameIds);
    const hashByFrame = new Map(result.frames.map((f) => [f.id, f.resultHash]));
    const project = get().project;
    if (project) {
      set({
        project: {
          ...project,
          frames: project.frames.map((f) =>
            hashByFrame.has(f.id) ? { ...f, resultHash: hashByFrame.get(f.id) } : f,
          ),
        },
      });
    }
    set({
      running: false,
      liveStatus: {},
      livePreview: {},
      status: result.status === "done" ? `done ✓ · ${frameIds.length} frame(s)` : `error: ${result.error ?? ""}`,
    });
  } catch (err) {
    set({ running: false, liveStatus: {}, status: `error: ${(err as Error).message}` });
  }
}

/** Route a live WS progress event to its frame. */
function applyProgress(
  set: (partial: Partial<ComicState>) => void,
  get: () => ComicState,
  e: NodeProgressEvent,
): void {
  if (!e.nodeId || e.nodeId === "*") return;
  const frameId = frameIdFromNodeId(e.nodeId);
  if (!frameId) return;
  const project = get().project;
  if (!project || !project.frames.some((f) => f.id === frameId)) return;

  const liveStatus = { ...get().liveStatus };
  const livePreview = { ...get().livePreview };
  // Drive status from the generation node; export node only contributes a preview.
  if (e.nodeId.startsWith("gen-")) liveStatus[frameId] = e.status;
  if (e.previewHash) livePreview[frameId] = e.previewHash;
  set({ liveStatus, livePreview });
}
