import type {
  AssetRef,
  AssistConfig,
  AssistRequest,
  AssistResponse,
  ComicProject,
  GraphDocument,
} from "@vengine/shared";
import type {
  ComicEditResult,
  ComicRunResult,
  FrameOutputDelta,
  ModelInfo,
  NodeManifestEntry,
  NodeProgressEvent,
  ProjectSummary,
  RunPlan,
  RunResult,
  SnapshotEntry,
} from "./types";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

function post<T>(url: string, body?: unknown): Promise<T> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  }).then(json<T>);
}

export const api = {
  models: () => fetch("/api/models").then(json<ModelInfo[]>),
  nodes: () => fetch("/api/nodes").then(json<NodeManifestEntry[]>),

  plan: (graph: GraphDocument, quality?: "preview" | "final", targets?: string[]) =>
    fetch("/api/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ graph, quality, targets }),
    }).then(json<RunPlan>),

  run: (graph: GraphDocument, quality?: "preview" | "final", targets?: string[]) =>
    fetch("/api/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ graph, quality, targets }),
    }).then(json<RunResult>),

  assetUrl: (hash: string) => `/api/assets/${hash}`,
  thumbUrl: (hash: string) => `/api/thumbs/${hash}`,

  // ── Comic Studio ──────────────────────────────────────────────────────────
  comics: () => fetch("/api/comics").then(json<ProjectSummary[]>),
  comic: (id: string) => fetch(`/api/comics/${id}`).then(json<ComicProject>),
  createComic: (name?: string) => post<ComicProject>("/api/comics", { name }),
  saveComic: (project: ComicProject) =>
    fetch(`/api/comics/${project.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(project),
    }).then(json<ComicProject>),
  planComic: (id: string, quality?: "preview" | "final", frameIds?: string[]) =>
    post<RunPlan>(`/api/comics/${id}/plan`, { quality, frameIds }),
  runComic: (id: string, quality?: "preview" | "final", frameIds?: string[]) =>
    post<ComicRunResult>(`/api/comics/${id}/run`, { quality, frameIds }),
  editFrame: (
    id: string,
    frameId: string,
    body: {
      baseHash: string;
      instruction: string;
      mode?: "tweak" | "restage";
      keepStyle?: boolean;
      seed?: number;
      quality?: "preview" | "final";
    },
  ) => post<ComicEditResult>(`/api/comics/${id}/frames/${frameId}/edit`, body),
  deleteVariant: (id: string, frameId: string, hash: string) =>
    fetch(`/api/comics/${id}/frames/${frameId}/variants/${hash}`, { method: "DELETE" }).then(
      json<FrameOutputDelta>,
    ),
  snapshotComic: (id: string) => post<SnapshotEntry>(`/api/comics/${id}/snapshot`),
  snapshots: (id: string) => fetch(`/api/comics/${id}/snapshots`).then(json<SnapshotEntry[]>),
  cancelRun: (runId: string) =>
    fetch(`/api/runs/${runId}/cancel`, { method: "POST" }).then((r) => r.ok),

  uploadAsset: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return fetch("/api/assets", { method: "POST", body: form }).then(json<AssetRef>);
  },

  // ── AI text assist ──────────────────────────────────────────────────────────
  assistConfig: () => fetch("/api/assist/config").then(json<AssistConfig>),
  assist: (req: AssistRequest) => post<AssistResponse>("/api/assist", req),
};

/** Subscribe to live run progress over WebSocket. Returns an unsubscribe fn. */
export function connectProgress(onEvent: (e: NodeProgressEvent) => void): () => void {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onmessage = (msg) => {
    try {
      onEvent(JSON.parse(msg.data) as NodeProgressEvent);
    } catch {
      /* ignore malformed frames */
    }
  };
  return () => ws.close();
}
