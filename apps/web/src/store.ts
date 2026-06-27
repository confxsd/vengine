import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
} from "@xyflow/react";
import type { GraphDocument } from "@vengine/shared";
import { api, connectProgress } from "./api";
import type {
  ModelInfo,
  NodeManifestEntry,
  NodeProgressEvent,
  NodeRunStatus,
  PortInfo,
  RunPlan,
} from "./types";

export interface VNodeData {
  type: string;
  title: string;
  category: NodeManifestEntry["category"];
  params: Record<string, unknown>;
  inputs: PortInfo[];
  outputs: PortInfo[];
  status?: NodeRunStatus;
  previewHash?: string;
  outputPath?: string;
  cost?: number;
  [key: string]: unknown;
}

export type VNode = Node<VNodeData>;

const DEFAULT_PARAMS: Record<string, Record<string, unknown>> = {
  "generate.text-to-image": {
    model: "mock/gradient",
    prompt: "a serene mountain lake at dawn, minimal, cinematic",
    width: 768,
    height: 768,
    seed: 42,
  },
  "compositing.resize": { width: 512, height: 512, fit: "cover" },
  "io.export": { dir: "~/Downloads", filename: "vengine-output", format: "png" },
  "io.load-image": { path: "" },
};

// Random suffixes keep ids unique across page reloads (a monotonic counter would
// reset to 0 on reload and collide with a persisted graph's ids).
const rid = () => Math.random().toString(36).slice(2, 8);
const newEdgeId = () => `e-${rid()}`;
const newNodeId = (type: string) => `${type.split(".").pop()}-${rid()}`;

interface StudioState {
  nodes: VNode[];
  edges: Edge[];
  models: ModelInfo[];
  manifest: NodeManifestEntry[];
  selectedId: string | null;
  quality: "preview" | "final";
  running: boolean;
  plan: RunPlan | null;
  status: string;
  lightboxHash: string | null;

  init: () => Promise<void>;
  resetWorkspace: () => void;
  openLightbox: (hash: string) => void;
  closeLightbox: () => void;
  onNodesChange: (c: NodeChange[]) => void;
  onEdgesChange: (c: EdgeChange[]) => void;
  onConnect: (c: Connection) => void;
  addNode: (type: string) => void;
  select: (id: string | null) => void;
  updateParams: (id: string, patch: Record<string, unknown>) => void;
  setQuality: (q: "preview" | "final") => void;
  toGraph: () => GraphDocument;
  doPlan: () => Promise<void>;
  doRun: () => Promise<void>;
}

function makeNode(entry: NodeManifestEntry, x: number, y: number): VNode {
  return {
    id: newNodeId(entry.type),
    type: "vnode",
    position: { x, y },
    data: {
      type: entry.type,
      title: entry.title,
      category: entry.category,
      params: { ...(DEFAULT_PARAMS[entry.type] ?? {}) },
      inputs: entry.inputs,
      outputs: entry.outputs,
    },
  };
}

export const useStudio = create<StudioState>()(
  persist(
    (set, get) => ({
  nodes: [],
  edges: [],
  models: [],
  manifest: [],
  selectedId: null,
  quality: "final",
  running: false,
  plan: null,
  status: "ready",
  lightboxHash: null,

  openLightbox: (hash) => set({ lightboxHash: hash }),
  closeLightbox: () => set({ lightboxHash: null }),

  init: async () => {
    const [models, manifest] = await Promise.all([api.models(), api.nodes()]);
    set({ models, manifest });
    const byType = (t: string) => manifest.find((m) => m.type === t);

    if (get().nodes.length === 0) {
      // First-ever load (empty persisted state): seed a demo graph.
      const gen = makeNode(byType("generate.text-to-image")!, 40, 120);
      const resize = makeNode(byType("compositing.resize")!, 420, 120);
      const exp = makeNode(byType("io.export")!, 800, 120);
      set({
        nodes: [gen, resize, exp],
        edges: [
          { id: newEdgeId(), source: gen.id, sourceHandle: "image", target: resize.id, targetHandle: "image" },
          { id: newEdgeId(), source: resize.id, sourceHandle: "image", target: exp.id, targetHandle: "image" },
        ],
      });
    } else {
      // Restored a saved workspace: refresh node defs against the current manifest
      // (ports/titles may have changed) and clear stale run status.
      set({
        nodes: get().nodes.map((n) => {
          const def = byType(n.data.type);
          return {
            ...n,
            data: {
              ...n.data,
              status: undefined,
              ...(def
                ? {
                    title: def.title,
                    category: def.category,
                    inputs: def.inputs,
                    outputs: def.outputs,
                  }
                : {}),
            },
          };
        }),
        status: "restored ✓",
      });
    }

    connectProgress((e) => applyProgress(set, get, e));
  },

  resetWorkspace: () => {
    const manifest = get().manifest;
    const byType = (t: string) => manifest.find((m) => m.type === t);
    const gen = byType("generate.text-to-image");
    const resize = byType("compositing.resize");
    const exp = byType("io.export");
    if (!gen || !resize || !exp) {
      set({ nodes: [], edges: [], selectedId: null });
      return;
    }
    const g = makeNode(gen, 40, 120);
    const r = makeNode(resize, 420, 120);
    const e = makeNode(exp, 800, 120);
    set({
      nodes: [g, r, e],
      edges: [
        { id: newEdgeId(), source: g.id, sourceHandle: "image", target: r.id, targetHandle: "image" },
        { id: newEdgeId(), source: r.id, sourceHandle: "image", target: e.id, targetHandle: "image" },
      ],
      selectedId: null,
      status: "reset",
    });
  },

  onNodesChange: (changes) => set({ nodes: applyNodeChanges(changes, get().nodes) as VNode[] }),
  onEdgesChange: (changes) => set({ edges: applyEdgeChanges(changes, get().edges) }),
  onConnect: (conn) => set({ edges: addEdge({ ...conn, id: newEdgeId() }, get().edges) }),

  addNode: (type) => {
    const entry = get().manifest.find((m) => m.type === type);
    if (!entry) return;
    const n = makeNode(entry, 120 + Math.random() * 240, 320 + Math.random() * 160);
    set({ nodes: [...get().nodes, n], selectedId: n.id });
  },

  select: (id) => set({ selectedId: id }),

  updateParams: (id, patch) =>
    set({
      nodes: get().nodes.map((n) =>
        n.id === id ? { ...n, data: { ...n.data, params: { ...n.data.params, ...patch } } } : n,
      ),
    }),

  setQuality: (quality) => set({ quality }),

  toGraph: (): GraphDocument => ({
    version: 1,
    id: "studio",
    name: "Studio",
    nodes: get().nodes.map((n) => ({
      id: n.id,
      type: n.data.type,
      position: n.position,
      params: n.data.params,
    })),
    edges: get().edges.map((e) => ({
      id: e.id,
      source: e.source,
      sourcePort: e.sourceHandle ?? "out",
      target: e.target,
      targetPort: e.targetHandle ?? "in",
    })),
  }),

  doPlan: async () => {
    try {
      const plan = await api.plan(get().toGraph(), get().quality);
      set({ plan, status: `plan: ${plan.willRunCount} run · ${plan.cachedCount} cached` });
    } catch (err) {
      set({ status: `plan error: ${(err as Error).message}` });
    }
  },

  doRun: async () => {
    if (get().running) return;
    // Don't bulk-reset node statuses — that flashes the whole graph as if it
    // restarted. Per-node WS events drive live status; cached nodes stay cached.
    set({ running: true, status: "running…", plan: null });
    try {
      const result = await api.run(get().toGraph(), get().quality);
      let ran = 0;
      let cached = 0;
      let cost = 0;
      const nodes = get().nodes.map((n) => {
        const r = result.nodes[n.id];
        if (!r) return n;
        if (r.status === "done") {
          ran += 1;
          cost += n.data.cost ?? 0; // cost arrived via WS during this run
        } else if (r.status === "cached") {
          cached += 1;
        }
        const img = (r.outputs?.image as { hash?: string } | undefined)?.hash;
        const outPath = typeof r.outputs?.path === "string" ? r.outputs.path : undefined;
        return {
          ...n,
          data: {
            ...n.data,
            status: r.status,
            previewHash: img ?? n.data.previewHash,
            outputPath: outPath ?? n.data.outputPath,
          },
        };
      });
      const costStr = cost > 0 ? ` · $${cost.toFixed(4)}` : " · $0 (cached)";
      set({
        running: false,
        nodes,
        status:
          result.status === "done"
            ? `done ✓ · ran ${ran} · cached ${cached}${costStr}`
            : `error: ${result.error ?? ""}`,
      });
    } catch (err) {
      set({ running: false, status: `error: ${(err as Error).message}` });
    }
  },
    }),
    {
      // Autosave the workspace to localStorage so closing the browser and
      // reopening continues exactly where you left off. Only the graph + prefs
      // are persisted; transient run flags (running/status/models) are not, and
      // generated assets already live server-side (content-addressed on disk).
      name: "vengine-workspace",
      version: 1,
      partialize: (s) => ({ nodes: s.nodes, edges: s.edges, quality: s.quality }),
    },
  ),
);

/** Apply a live WS progress event to the matching node. */
function applyProgress(
  set: (partial: Partial<StudioState>) => void,
  get: () => StudioState,
  e: NodeProgressEvent,
): void {
  if (!e.nodeId || e.nodeId === "*") return;
  set({
    nodes: get().nodes.map((n) =>
      n.id === e.nodeId
        ? {
            ...n,
            data: {
              ...n.data,
              status: e.status,
              previewHash: e.previewHash ?? n.data.previewHash,
              cost: e.cost ?? n.data.cost,
            },
          }
        : n,
    ),
  });
}
