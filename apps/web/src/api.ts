import type {
  AssetRef,
  AssistConfig,
  AssistRequest,
  AssistResponse,
  ComicProject,
  GraphDocument,
  Library,
  LibraryCharacter,
  StylePack,
  TrainedLora,
  TrainingProgressEvent,
} from "@vengine/shared";
import { isTrainingEvent } from "@vengine/shared";
import type { TrainerInfo, StartTrainingRequest } from "./types";
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

  // ── Cross-project Library ─────────────────────────────────────────────────────
  library: () => fetch("/api/library").then(json<Library>),
  trainers: () => fetch("/api/trainers").then(json<TrainerInfo[]>),
  upsertCharacter: (c: LibraryCharacter) =>
    fetch("/api/library/characters", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(c),
    }).then(json<LibraryCharacter>),
  removeCharacter: (id: string) =>
    fetch(`/api/library/characters/${id}`, { method: "DELETE" }).then((r) => r.ok),
  upsertStyle: (s: StylePack) =>
    fetch("/api/library/styles", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(s),
    }).then(json<StylePack>),
  removeStyle: (id: string) =>
    fetch(`/api/library/styles/${id}`, { method: "DELETE" }).then((r) => r.ok),
  startTraining: (req: StartTrainingRequest) => post<TrainedLora>("/api/training", req),
  removeLora: (id: string) =>
    fetch(`/api/library/loras/${id}`, { method: "DELETE" }).then((r) => r.ok),
};

/**
 * A **self-healing** WebSocket to `/ws`. Long-lived work (a multi-minute training, a
 * generation run) outlives transient drops (sleep, network change, server restart),
 * so the socket reconnects with capped exponential backoff. `onMessage` receives each
 * parsed frame; `onReopen(first)` fires on every successful open with `first=true`
 * only on the very first connect, so callers can resync (refetch truth) after a drop
 * without resyncing on startup. Returns an unsubscribe that stops the socket and any
 * pending reconnect. Errors before the first open still reconnect (so init order /
 * a cold server can't leave the client permanently socket-less).
 */
function reconnectingWs(opts: {
  onMessage: (data: unknown) => void;
  onReopen?: (first: boolean) => void;
}): () => void {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  let ws: WebSocket | null = null;
  let closed = false;
  let first = true;
  let backoff = 500;
  let retry: ReturnType<typeof setTimeout> | undefined;

  const connect = () => {
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => {
      opts.onReopen?.(first);
      first = false;
      backoff = 500;
    };
    ws.onmessage = (msg) => {
      try {
        opts.onMessage(JSON.parse(msg.data));
      } catch {
        /* ignore malformed frames */
      }
    };
    ws.onclose = () => {
      if (closed) return;
      retry = setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 10_000); // cap the backoff
    };
    ws.onerror = () => ws?.close();
  };
  connect();

  return () => {
    closed = true;
    if (retry) clearTimeout(retry);
    ws?.close();
  };
}

/** Subscribe to live run progress over a self-healing WebSocket. Returns unsubscribe.
 *  Run results are HTTP-authoritative, so no resync-on-reconnect is needed — but the
 *  socket must reconnect or live frame previews freeze for the session after any drop. */
export function connectProgress(onEvent: (e: NodeProgressEvent) => void): () => void {
  return reconnectingWs({ onMessage: (e) => onEvent(e as NodeProgressEvent) });
}

/**
 * Subscribe to **training** progress. WS events are live hints; the persisted library
 * is the source of truth, so on every *re*connect we fire `onReconnect` to refetch it
 * (catching any transition missed while disconnected).
 */
export function connectLibrary(handlers: {
  onTraining: (lora: TrainingProgressEvent["lora"]) => void;
  onReconnect?: () => void;
}): () => void {
  return reconnectingWs({
    onMessage: (e) => {
      if (isTrainingEvent(e)) handlers.onTraining(e.lora);
    },
    onReopen: (first) => {
      if (!first) handlers.onReconnect?.();
    },
  });
}
