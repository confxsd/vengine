import { z } from "zod";

/**
 * The serializable graph document. This is the portable, diffable source of
 * truth persisted to SQLite and exchanged with the client. It is intentionally
 * free of executor logic — node *behaviour* lives in the node registry, keyed
 * by `type`.
 */

export const NodeInstanceSchema = z.object({
  /** Unique within a graph. */
  id: z.string().min(1),
  /** References a registered NodeDefinition.type, e.g. "generate.text-to-image". */
  type: z.string().min(1),
  /** Canvas position; purely cosmetic, excluded from cache keys. */
  position: z.object({ x: z.number(), y: z.number() }),
  /** Param values validated against the node definition's param schema at runtime. */
  params: z.record(z.unknown()).default({}),
  /** Optional human label override. */
  title: z.string().optional(),
});
export type NodeInstance = z.infer<typeof NodeInstanceSchema>;

export const EdgeSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  sourcePort: z.string().min(1),
  target: z.string().min(1),
  targetPort: z.string().min(1),
});
export type Edge = z.infer<typeof EdgeSchema>;

export const GraphDocumentSchema = z.object({
  /** Schema version for forward-compatible migrations. */
  version: z.literal(1).default(1),
  id: z.string().min(1),
  name: z.string().default("Untitled"),
  nodes: z.array(NodeInstanceSchema).default([]),
  edges: z.array(EdgeSchema).default([]),
});
export type GraphDocument = z.infer<typeof GraphDocumentSchema>;
