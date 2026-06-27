import { z } from "zod";

/** Lifecycle of a single node within a run. `cached` means the result was reused. */
export const NodeRunStatus = z.enum([
  "pending",
  "queued",
  "running",
  "cached",
  "done",
  "error",
  "skipped",
]);
export type NodeRunStatus = z.infer<typeof NodeRunStatus>;

export const RunStatus = z.enum(["pending", "running", "done", "error", "cancelled"]);
export type RunStatus = z.infer<typeof RunStatus>;

/** A progress event streamed to the client over WebSocket during execution. */
export const NodeProgressEventSchema = z.object({
  runId: z.string(),
  nodeId: z.string(),
  status: NodeRunStatus,
  /** Optional thumbnail asset hash for live preview. */
  previewHash: z.string().length(64).optional(),
  /** Estimated or actual cost in USD attributed to this node. */
  cost: z.number().nonnegative().optional(),
  error: z.string().optional(),
  at: z.string().datetime(),
});
export type NodeProgressEvent = z.infer<typeof NodeProgressEventSchema>;
