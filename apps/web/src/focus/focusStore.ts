import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { GraphDocument, NodeRunStatus } from "@vengine/shared";
import { api, connectProgress } from "../api";
import type { ModelInfo, NodeProgressEvent, RunPlan, RunResult } from "../types";

/**
 * Focus Mode — one image under the loupe, iterated through a divergent edit tree.
 * Every node is an instruction-driven `generate.image-edit` of its parent's image;
 * siblings run in parallel on the engine (bounded concurrency), and the content-
 * addressed cache makes unchanged branches free on re-run. The tree compiles to a
 * plain GraphDocument (source node + edit nodes) run through the stock /api/plan
 * and /api/run endpoints, so the focus layer adds zero server surface.
 */

export type EditMode = "tweak" | "restage";

/** A weighted reference image (mirrors the shared ComicReference shape). */
export interface FocusRef {
  hash: string;
  weight?: number;
}

export interface FocusLora {
  path: string;
  scale?: number;
}

/** Everything that defines one edit node's run. */
export interface FocusNodeParams {
  /** What to change; empty = a bare tweak/restage of the parent image. */
  instruction: string;
  mode: EditMode;
  /** Per-node seed; a fresh roll explores, a fixed value reproduces. */
  seed?: number;
  /** Optional style theme clause appended to the edit prompt. */
  theme?: string;
  /** Model override; undefined = the session default. */
  model?: string;
  negativePrompt?: string;
  /** Secondary references (style anchors / identity refs); the parent image leads. */
  references: FocusRef[];
  loras?: FocusLora[];
  width?: number;
  height?: number;
  steps?: number;
  guidance?: number;
}

export interface FocusNodeResult {
  hash?: string;
  status?: NodeRunStatus;
  cost?: number;
  error?: string;
}

/** One edit node in the focus tree. `parentId: null` = child of the source image. */
export interface FocusNode {
  id: string;
  parentId: string | null;
  params: FocusNodeParams;
  result?: FocusNodeResult;
  /** Manual canvas position; undefined = auto-laid out by the tidy tree layout. */
  position?: { x: number; y: number };
}

/** Session-wide defaults inherited by every node (each can override). */
export interface FocusSession {
  name: string;
  modelId: string;
  quality: "preview" | "final";
  width: number;
  height: number;
  negative: string;
}

/** The source node's fixed graph id (the tree's root). */
export const SOURCE_NODE_ID = "src-root";

const rid = () => Math.random().toString(36).slice(2, 8);
const newEditId = () => `edit-${rid()}`;
const newEdgeId = (parent: string, child: string) => `e-${parent}-${child}`;

const randomSeed = () => Math.floor(Math.random() * 2 ** 31);

function defaultParams(over: Partial<FocusNodeParams> = {}): FocusNodeParams {
  return {
    instruction: "",
    mode: "tweak",
    references: [],
    ...over,
  };
}

interface FocusState {
  sourceHash: string | null;
  nodes: FocusNode[];
  selectedId: string | null;
  session: FocusSession;
  running: boolean;
  runId: string | null;
  status: string;
  plan: RunPlan | null;
  /** Node ids a running/queued run covers (drives local "queued" chips). */
  queuedIds: string[];
  /** Manual canvas position of the source root card; undefined = auto layout. */
  rootPos?: { x: number; y: number };

  init: () => void;
  setSource: (hash: string) => void;
  updateSession: (patch: Partial<FocusSession>) => void;
  /** Create a child edit under `parentId` (null = root), select it, return its id. */
  addEdit: (parentId: string | null, over?: Partial<FocusNodeParams>) => string;
  /** Diverge: `count` siblings of `parentId` with the same instruction, fresh seeds. */
  split: (parentId: string | null, count: number) => void;
  duplicate: (id: string) => void;
  /** Remove a node and its whole subtree. */
  removeNode: (id: string) => void;
  /** Move a node to a manual canvas position (exits auto layout for it). */
  moveNode: (id: string, pos: { x: number; y: number }) => void;
  /** Move the source root card to a manual canvas position. */
  moveRoot: (pos: { x: number; y: number }) => void;
  /** Drop all manual positions and re-run the tidy auto layout. */
  autoArrange: () => void;
  /** Prune every descendant's result when an ancestor changes (results are stale). */
  touch: (id: string) => void;
  updateParams: (id: string, patch: Partial<FocusNodeParams>) => void;
  select: (id: string | null) => void;
  /** The node by id (undefined for the synthetic root). */
  nodeById: (id: string) => FocusNode | undefined;
  /**
   * A "branch" = the subtree rooted at a node: the node plus every descendant.
   * The run scope for "Run this branch" — so a fresh split runs all its children,
   * not just the selected parent.
   */
  branchIds: (id: string) => string[];
  /** Children of a node (or of the root when `parentId` is null). */
  childrenOf: (parentId: string | null) => FocusNode[];
  /** The image hash a node currently shows (its result, else the parent's, else the source). */
  visibleHash: (id: string) => string | null;
  toGraph: () => GraphDocument | null;
  planRun: (targets?: string[]) => Promise<void>;
  runGraph: (targets?: string[]) => Promise<void>;
  cancel: () => Promise<void>;
  resetTree: () => void;
}

/** Guard against a second WS on a hot-reload remount. */
let initialized = false;
/** The live socket's unsubscribe, kept at module scope so HMR can close it. */
let socketUnsub: (() => void) | undefined;

export const useFocus = create<FocusState>()(
  persist(
    (set, get) => ({
      sourceHash: null,
      nodes: [],
      selectedId: null,
      session: {
        name: "Untitled study",
        modelId: "",
        quality: "final",
        width: 768,
        height: 1344,
        negative: "",
      },
      running: false,
      runId: null,
      status: "ready",
      plan: null,
      queuedIds: [],
      rootPos: undefined,

      init: () => {
        if (initialized) return;
        initialized = true;
        socketUnsub?.();
        socketUnsub = connectProgress((e) => applyProgress(set, get, e));
      },

      setSource: (hash) => set({ sourceHash: hash }),

      updateSession: (patch) => set({ session: { ...get().session, ...patch } }),

      addEdit: (parentId, over) => {
        const id = newEditId();
        const node: FocusNode = {
          id,
          parentId,
          params: defaultParams({ seed: randomSeed(), ...over }),
        };
        set({ nodes: [...get().nodes, node], selectedId: id });
        return id;
      },

      split: (parentId, count) => {
        const base = parentId ? get().nodes.find((n) => n.id === parentId) : undefined;
        const kids: FocusNode[] = Array.from({ length: count }, () => ({
          id: newEditId(),
          parentId,
          params: defaultParams({
            instruction: base?.params.instruction ?? "",
            mode: base?.params.mode ?? "tweak",
            seed: randomSeed(),
          }),
        }));
        set({ nodes: [...get().nodes, ...kids] });
      },

      duplicate: (id) => {
        const src = get().nodes.find((n) => n.id === id);
        if (!src) return;
        const copy: FocusNode = {
          id: newEditId(),
          parentId: src.parentId,
          params: {
            ...src.params,
            seed: randomSeed(),
            references: [...src.params.references],
            loras: src.params.loras ? [...src.params.loras] : undefined,
          },
        };
        set({ nodes: [...get().nodes, copy], selectedId: copy.id });
      },

      removeNode: (id) => {
        const dead = new Set([id]);
        // Cascade: removing a node removes its whole subtree.
        let grew = true;
        while (grew) {
          grew = false;
          for (const n of get().nodes) {
            if (n.parentId && dead.has(n.parentId) && !dead.has(n.id)) {
              dead.add(n.id);
              grew = true;
            }
          }
        }
        const nodes = get().nodes.filter((n) => !dead.has(n.id));
        const sel = get().selectedId;
        const selectedId = sel && dead.has(sel) ? null : sel;
        set({ nodes, selectedId });
      },

      moveNode: (id, pos) =>
        set({
          nodes: get().nodes.map((n) => (n.id === id ? { ...n, position: pos } : n)),
        }),

      moveRoot: (pos) => set({ rootPos: pos }),

      autoArrange: () =>
        set({
          nodes: get().nodes.map((n) => ({ ...n, position: undefined })),
          rootPos: undefined,
        }),

      touch: (id) => {
        // A param change makes this node and every descendant stale: drop results
        // (the engine cache still skips identical re-runs, but the UI must not show
        // a stale image as current — pending cards fall back to the parent's image).
        const stale = new Set([id]);
        let grew = true;
        while (grew) {
          grew = false;
          for (const n of get().nodes) {
            if (n.parentId && stale.has(n.parentId) && !stale.has(n.id)) {
              stale.add(n.id);
              grew = true;
            }
          }
        }
        set({
          nodes: get().nodes.map((n) => (stale.has(n.id) ? { ...n, result: undefined } : n)),
        });
      },

      updateParams: (id, patch) => {
        get().touch(id);
        set({
          nodes: get().nodes.map((n) =>
            n.id === id ? { ...n, params: { ...n.params, ...patch } } : n,
          ),
        });
      },

      select: (id) => set({ selectedId: id }),

      nodeById: (id) => get().nodes.find((n) => n.id === id),

      branchIds: (id) => {
        const out = [id];
        const walk = (pid: string) => {
          for (const n of get().nodes) {
            if (n.parentId === pid) {
              out.push(n.id);
              walk(n.id);
            }
          }
        };
        walk(id);
        return out;
      },

      childrenOf: (parentId) => get().nodes.filter((n) => n.parentId === parentId),

      visibleHash: (id) => {
        const node = get().nodes.find((n) => n.id === id);
        if (!node) return null;
        if (node.result?.hash) return node.result.hash;
        if (node.parentId) return get().visibleHash(node.parentId);
        return get().sourceHash;
      },

      toGraph: () => {
        const { sourceHash, nodes, session } = get();
        if (!sourceHash) return null;
        const graphNodes: GraphDocument["nodes"] = [
          {
            id: SOURCE_NODE_ID,
            type: "io.source",
            position: { x: 0, y: 0 },
            params: { hash: sourceHash },
          },
          ...nodes.map((n) => {
            const p = n.params;
            return {
              id: n.id,
              type: "generate.image-edit",
              position: { x: 0, y: 0 },
              params: {
                model: p.model ?? session.modelId,
                instruction: p.instruction,
                mode: p.mode,
                ...(p.theme?.trim() ? { theme: p.theme } : {}),
                ...(p.seed !== undefined ? { seed: p.seed } : {}),
                ...((p.negativePrompt ?? session.negative).trim()
                  ? { negativePrompt: (p.negativePrompt ?? session.negative).trim() }
                  : {}),
                ...(p.references.length ? { references: p.references } : {}),
                ...(p.loras?.length ? { loras: p.loras } : {}),
                ...(p.width ?? session.width ? { width: p.width ?? session.width } : {}),
                ...(p.height ?? session.height ? { height: p.height ?? session.height } : {}),
                ...(p.steps !== undefined ? { steps: p.steps } : {}),
                ...(p.guidance !== undefined ? { guidance: p.guidance } : {}),
              },
            };
          }),
        ];
        const edges: GraphDocument["edges"] = nodes.map((n) => ({
          id: newEdgeId(n.parentId ?? SOURCE_NODE_ID, n.id),
          source: n.parentId ?? SOURCE_NODE_ID,
          sourcePort: "image",
          target: n.id,
          targetPort: "image",
        }));
        return {
          version: 1,
          id: "focus",
          name: session.name || "Focus",
          nodes: graphNodes,
          edges,
        };
      },

      planRun: async (targets) => {
        const graph = get().toGraph();
        if (!graph) return;
        try {
          const plan = await api.plan(graph, get().session.quality, targets);
          set({
            plan,
            status: `estimate: ${plan.willRunCount} run · ${plan.cachedCount} cached · ~$${plan.estTotalCost.toFixed(4)}`,
          });
        } catch (err) {
          set({ status: `plan error: ${(err as Error).message}` });
        }
      },

      runGraph: async (targets) => {
        if (get().running) return;
        const graph = get().toGraph();
        if (!graph || graph.nodes.length <= 1) {
          set({ status: "add an edit node first" });
          return;
        }
        // Local "queued" chips until the executor's per-node events take over.
        const queuedIds = targets
          ? get().nodes.filter((n) => targets.includes(n.id)).map((n) => n.id)
          : get().nodes.map((n) => n.id);
        set({ running: true, status: "running…", plan: null, queuedIds });
        try {
          const result = await api.run(graph, get().session.quality, targets);
          applyRunResult(set, get, result);
          // Surface the fresh output in the big inspector preview.
          if (targets?.length === 1) set({ selectedId: targets[0] });
        } catch (err) {
          set({ running: false, status: `error: ${(err as Error).message}`, queuedIds: [] });
        }
      },

      cancel: async () => {
        const runId = get().runId;
        if (!runId) return;
        await api.cancelRun(runId).catch(() => {});
        set({ status: "cancelling…" });
      },

      resetTree: () =>
        set({
          nodes: [],
          selectedId: null,
          status: "reset",
          plan: null,
          queuedIds: [],
        }),
    }),
    {
      name: "vengine-focus-workspace",
      version: 1,
      partialize: (s) => ({
        sourceHash: s.sourceHash,
        selectedId: s.selectedId,
        session: s.session,
        rootPos: s.rootPos,
        // Persist results (hashes/cost) but never transient run state.
        nodes: s.nodes.map((n) => ({
          ...n,
          result: n.result ? { hash: n.result.hash, cost: n.result.cost } : undefined,
        })),
      }),
    },
  ),
);

/** Route a live WS progress event to its node. */
function applyProgress(
  set: (partial: Partial<FocusState>) => void,
  get: () => FocusState,
  e: NodeProgressEvent,
): void {
  // Run brackets: remember the runId so Cancel can abort an in-flight run.
  if (e.nodeId === "*") {
    if (e.status === "running" && e.runId) set({ runId: e.runId });
    return;
  }
  set({
    nodes: get().nodes.map((n) =>
      n.id === e.nodeId
        ? {
            ...n,
            result: {
              ...n.result,
              status: e.status,
              hash: e.previewHash ?? n.result?.hash,
              cost: e.cost ?? n.result?.cost,
            },
          }
        : n,
    ),
  });
}

/** Apply the HTTP-authoritative run result to every node it covers. */
function applyRunResult(
  set: (partial: Partial<FocusState>) => void,
  get: () => FocusState,
  result: RunResult,
): void {
  let ran = 0;
  let cached = 0;
  let errored = 0;
  let cost = 0;
  const nodes = get().nodes.map((n) => {
    const r = result.nodes[n.id];
    if (!r) return n;
    if (r.status === "done") {
      ran += 1;
      cost += n.result?.cost ?? 0;
    } else if (r.status === "cached") {
      cached += 1;
    } else if (r.status === "error") {
      errored += 1;
    }
    const img = (r.outputs?.image as { hash?: string } | undefined)?.hash;
    return {
      ...n,
      result: {
        status: r.status,
        hash: img ?? n.result?.hash,
        cost: n.result?.cost,
        error: r.error,
      },
    };
  });
  const costStr = cost > 0 ? ` · $${cost.toFixed(4)}` : "";
  set({
    running: false,
    nodes,
    queuedIds: [],
    status:
      result.status === "done"
        ? `done ✓ · ran ${ran} · cached ${cached}${costStr}`
        : `error: ${result.error ?? ""} (${errored} failed)`,
  });
}

/** The models an edit node can actually use: reference-consuming only. */
export function editCapableModels(models: ModelInfo[]): ModelInfo[] {
  return models.filter((m) => m.consumesReferences);
}

/** Option label marking models that ignore image references (edits degrade to t2i). */
export function modelLabel(m: ModelInfo): string {
  return m.consumesReferences ? m.displayName : `${m.displayName} (no image refs)`;
}

// Close the live socket on a hot-module swap so dev reloads don't leak reconnecting
// sockets (the same pattern as libraryStore).
const hot = (import.meta as { hot?: { dispose: (cb: () => void) => void } }).hot;
if (hot) hot.dispose(() => socketUnsub?.());
