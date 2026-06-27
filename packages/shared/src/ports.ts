/**
 * The port type system. Ports are the typed connection points on nodes;
 * an edge may only connect an output port to an input port of a compatible type.
 *
 * Keep this list closed and explicit — the UI, validation, and adapter layers
 * all switch on it. Adding a type is a deliberate, cross-cutting change.
 */
export const PORT_TYPES = [
  "image",
  "mask",
  "imageBatch",
  "prompt",
  "string",
  "number",
  "int",
  "seed",
  "boolean",
  "enum",
  "color",
  "model",
  "reference",
] as const;

export type PortType = (typeof PORT_TYPES)[number];

/**
 * Compatibility rules for connecting an output port (`from`) to an input
 * port (`to`). Default is exact-match; this table encodes the allowed
 * widening/coercions (e.g. a single image flows into an imageBatch slot).
 */
const COMPATIBILITY: Partial<Record<PortType, readonly PortType[]>> = {
  image: ["image", "imageBatch", "reference"],
  imageBatch: ["imageBatch"],
  int: ["int", "number", "seed"],
  number: ["number"],
  seed: ["seed", "int"],
  string: ["string", "prompt"],
  prompt: ["prompt", "string"],
};

/** True if a value produced as `from` can be fed into an input of type `to`. */
export function arePortsCompatible(from: PortType, to: PortType): boolean {
  if (from === to) return true;
  return COMPATIBILITY[from]?.includes(to) ?? false;
}
