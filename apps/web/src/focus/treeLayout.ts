/**
 * Tidy left→right tree layout for the focus tree. A first-walk Reingold–Tilford:
 * leaves stack sequentially in their own rows (so cousin subtrees can never
 * overlap), parents center on their children, columns are depth-indexed. Small
 * enough that the O(n²) second walk isn't needed.
 */

export interface TreeEntry {
  id: string;
  parentId: string | null;
}

export interface TreeLayout {
  /** Center position of each node (id → x/y). */
  positions: Map<string, { x: number; y: number }>;
  width: number;
  height: number;
}

export const CARD_W = 200;
export const CARD_H = 224;
export const COL_GAP = 96;
export const ROW_GAP = 32;

export function layoutTree(
  entries: TreeEntry[],
  rootId: string,
  opts: { cardW?: number; cardH?: number; colGap?: number; rowGap?: number } = {},
): TreeLayout {
  const cardW = opts.cardW ?? CARD_W;
  const cardH = opts.cardH ?? CARD_H;
  const colGap = opts.colGap ?? COL_GAP;
  const rowGap = opts.rowGap ?? ROW_GAP;

  const children = new Map<string, string[]>();
  const parentOf = new Map(entries.map((e) => [e.id, e.parentId]));
  for (const e of entries) {
    const key = e.parentId ?? rootId;
    if (!children.has(key)) children.set(key, []);
    children.get(key)!.push(e.id);
  }
  const depthOf = (id: string): number => {
    if (id === rootId) return 0;
    const parent = parentOf.get(id);
    return parent === null || parent === undefined ? 0 : depthOf(parent) + 1;
  };

  const positions = new Map<string, { x: number; y: number }>();
  let nextLeafY = 0;
  let maxDepth = 0;

  /** Place a subtree; returns the y-extent it occupies (center coords). */
  const place = (id: string, depth: number): { top: number; bottom: number } => {
    maxDepth = Math.max(maxDepth, depth);
    const kids = children.get(id) ?? [];
    const x = depth * (cardW + colGap);
    if (kids.length === 0) {
      const y = nextLeafY;
      nextLeafY += cardH + rowGap;
      positions.set(id, { x, y });
      return { top: y, bottom: y + cardH };
    }
    const extents = kids.map((k) => place(k, depth + 1));
    const top = extents[0]!.top;
    const bottom = extents.at(-1)!.bottom;
    const y = (top + bottom) / 2 - cardH / 2;
    positions.set(id, { x, y });
    return { top, bottom };
  };

  place(rootId, 0);

  return {
    positions,
    width: (maxDepth + 1) * cardW + maxDepth * colGap,
    height: Math.max(cardH, nextLeafY - rowGap),
  };
}
