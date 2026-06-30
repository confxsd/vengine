import type {
  ComicAsset,
  ComicFrame,
  ComicProject,
  ComicReference,
  ComicStyle,
  ComicVariant,
  Library,
  LibraryCharacter,
  SceneReference,
  SceneBreakdown,
  Series,
  StylePack,
  TrainedLora,
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
  Library,
  LibraryCharacter,
  SceneReference,
  SceneBreakdown,
  Series,
  StylePack,
  TrainedLora,
};

/** Availability probe for scene description (mirrors `GET /api/scenes/config`). */
export interface SceneConfig {
  available: boolean;
  model: string | null;
}

/** Trainer manifest entry (mirrors the server's `trainerManifest`). */
export interface TrainerInfo {
  id: string;
  displayName: string;
  baseModelId: string;
  trains: "subject" | "style" | "both";
  /** USD per training step — drives the cost estimate (single source of truth). */
  pricePerStep: number;
}

/** Body for `POST /api/training` (mirrors the server's `TrainBody`). */
export interface StartTrainingRequest {
  trainerId: string;
  name: string;
  kind: "subject" | "style";
  refHashes: string[];
  captions?: string[];
  triggerWord?: string;
  defaultCaption?: string;
  isStyle?: boolean;
  steps?: number;
  characterId?: string;
}

/** A crop rectangle in full-resolution sheet pixels (mirrors providers' `Box`). */
export interface SheetBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One proposed crop from a character sheet: its box, a heuristic "looks like a pose"
 *  hint (pre-selected in the review grid), and an inline preview for that grid. */
export interface SheetRegion {
  box: SheetBox;
  suggested: boolean;
  preview: string;
}

/** Response of POST /api/library/sheet/segment. */
export interface SheetSegmentResult {
  width: number;
  height: number;
  regions: SheetRegion[];
}

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
  /** Frames that actually re-rendered this run (cache miss). */
  generated: number;
  /** Frames returned unchanged from cache (identical inputs → same image). */
  cached: number;
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
  /** Hard cap on reference images this model accepts; extras are dropped (tail-first). */
  maxReferences?: number;
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
