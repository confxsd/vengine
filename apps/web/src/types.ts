import type {
  ComicAsset,
  ComicFrame,
  ComicProject,
  ComicReference,
  ComicStyle,
  ComicVariant,
  NodeProgressEvent,
  NodeRunStatus,
} from "@vengine/shared";

export type {
  NodeProgressEvent,
  NodeRunStatus,
  ComicAsset,
  ComicProject,
  ComicFrame,
  ComicReference,
  ComicStyle,
  ComicVariant,
};

/** Mirrors @vengine/storage ProjectStore.ProjectSummary (server-only package). */
export interface ProjectSummary {
  id: string;
  name: string;
  frameCount: number;
  updatedAt: string;
  coverHash?: string;
}

export interface SnapshotEntry {
  id: string;
  createdAt: string;
}

/** A frame's server-authoritative generation outputs (selection + history). */
export interface FrameOutputDelta {
  id: string;
  resultHash?: string;
  variants: ComicVariant[];
}

/** Response of POST /api/comics/:id/run. */
export interface ComicRunResult {
  runId: string;
  status: "pending" | "running" | "done" | "error" | "cancelled";
  error?: string;
  frames: FrameOutputDelta[];
}

/** Response of POST /api/comics/:id/frames/:frameId/edit (one frame's new output). */
export interface ComicEditResult {
  runId: string;
  status: "pending" | "running" | "done" | "error" | "cancelled";
  error?: string;
  frame: FrameOutputDelta | null;
}

export interface PortInfo {
  id: string;
  type: string;
  label: string;
  required?: boolean;
  multiple?: boolean;
}

export interface NodeManifestEntry {
  type: string;
  title: string;
  category: "generation" | "compositing" | "io" | "logic" | "intelligence";
  inputs: PortInfo[];
  outputs: PortInfo[];
}

export interface ModelInfo {
  id: string;
  provider: string;
  displayName: string;
  capabilities: string[];
  /** True when the model actually applies reference images (style anchor / cast). */
  consumesReferences: boolean;
  /** True when the model actually applies LoRAs. */
  consumesLoras: boolean;
  pricing: { kind: string; usd: number };
}

export interface PlanNode {
  nodeId: string;
  type: string;
  willRun: boolean;
  estCost: number;
}
export interface RunPlan {
  nodes: PlanNode[];
  willRunCount: number;
  cachedCount: number;
  estTotalCost: number;
}

export interface AssetRef {
  hash: string;
  mime: string;
  width?: number;
  height?: number;
}

export interface NodeResult {
  nodeId: string;
  status: NodeRunStatus;
  outputs?: Record<string, unknown>;
  error?: string;
}
export interface RunResult {
  runId: string;
  status: "pending" | "running" | "done" | "error" | "cancelled";
  error?: string;
  nodes: Record<string, NodeResult>;
}
