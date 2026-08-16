import { useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  GitFork,
  LayoutGrid,
  Loader2,
  Maximize2,
  Plus,
  Trash2,
  Upload,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useStudio } from "../store";
import { api } from "../api";
import { IconButton } from "../components/ui";
import { cn } from "@/lib/cn";
import { useFocus, SOURCE_NODE_ID, type FocusNode } from "./focusStore";
import type { NodeRunStatus } from "@vengine/shared";
import { layoutTree, CARD_W, CARD_H } from "./treeLayout";

const STATUS_CHIP: Record<NodeRunStatus, { label: string; className: string }> = {
  pending: { label: "pending", className: "bg-elevated/80 text-faint" },
  queued: { label: "queued", className: "bg-elevated/80 text-faint" },
  running: { label: "running", className: "bg-accent/20 text-accent" },
  done: { label: "done", className: "bg-up/15 text-up" },
  cached: { label: "cached", className: "bg-cyan/15 text-cyan" },
  error: { label: "error", className: "bg-down/15 text-down" },
  skipped: { label: "skipped", className: "bg-elevated/80 text-faint" },
};

/** A status chip + spinner overlay for a card's thumb. */
function StatusOverlay({ status }: { status?: NodeRunStatus }) {
  if (!status) return null;
  const chip = STATUS_CHIP[status]!;
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between p-1">
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide",
          chip.className,
        )}
      >
        {status === "running" && <Loader2 className="h-2.5 w-2.5 animate-spin" />}
        {chip.label}
      </span>
    </div>
  );
}

/** One tree card: the source (root) or an edit node. Draggable across the canvas. */
function TreeCard({
  node,
  x,
  y,
  isRoot,
  onAdd,
  onSplit,
  onDelete,
  onDragStart,
}: {
  node: FocusNode | null;
  x: number;
  y: number;
  isRoot: boolean;
  onAdd: () => void;
  onSplit: () => void;
  onDelete?: () => void;
  onDragStart: (e: React.PointerEvent) => void;
}) {
  const selectedId = useFocus((s) => s.selectedId);
  const select = useFocus((s) => s.select);
  const openLightbox = useStudio((s) => s.openLightbox);
  const queuedIds = useFocus((s) => s.queuedIds);
  const sourceHash = useFocus((s) => s.sourceHash);
  const visibleHash = useFocus((s) => s.visibleHash);

  const hash = isRoot ? sourceHash : node ? visibleHash(node.id) : null;
  const status: NodeRunStatus | undefined = node?.result?.status;
  const isQueued = !!node && queuedIds.includes(node.id);
  const selected = !isRoot && selectedId === node?.id;

  // One-shot reveal when a fresh output lands (same treatment as comic frames).
  const [revealed, setRevealed] = useState(false);
  const lastHash = useRef<string | undefined>(node?.result?.hash);
  useLayoutEffect(() => {
    if (node?.result?.hash && node.result.hash !== lastHash.current) {
      lastHash.current = node.result.hash;
      setRevealed(true);
      const t = setTimeout(() => setRevealed(false), 2600);
      return () => clearTimeout(t);
    }
  }, [node?.result?.hash]);

  return (
    <div
      className="absolute touch-none select-none"
      style={{ left: x, top: y, width: CARD_W, height: CARD_H }}
      onClick={() => !isRoot && node && select(node.id)}
      onDoubleClick={() => hash && openLightbox(hash)}
      onPointerDown={(e) => {
        // Left-button drags move the card; other buttons pan/select normally.
        if (e.button === 0) onDragStart(e);
      }}
    >
      <div
        className={cn(
          "group relative flex h-full w-full cursor-grab flex-col overflow-hidden rounded-lg bg-card ring-1 transition active:cursor-grabbing",
          selected ? "ring-2 ring-accent" : "ring-border hover:ring-border-strong",
          revealed && "frame-reveal",
        )}
      >
        {/* Thumb: a finished node shows its own image; a pending one shows the
            parent's (the image it will edit) via visibleHash fallback. */}
        <div className="relative h-[160px] w-full shrink-0 overflow-hidden bg-elevated/40">
          {hash ? (
            <img
              src={api.thumbUrl(hash)}
              alt=""
              draggable={false}
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-[10px] text-faint">
              {isRoot ? "choose a source image" : "pending"}
            </div>
          )}
          <StatusOverlay status={isQueued ? "queued" : status} />
        </div>

        {/* Info */}
        <div className="flex min-h-0 flex-1 flex-col justify-between gap-1 px-2 py-1.5">
          <p className="line-clamp-2 text-[10px] leading-snug text-muted">
            {isRoot ? (
              <span className="text-faint italic">source</span>
            ) : (
              node!.params.instruction || (
                <span className="text-faint italic">
                  bare {node!.params.mode} — no instruction
                </span>
              )
            )}
          </p>
          <div className="flex items-center justify-between font-mono text-[9px] text-faint">
            {node?.params.seed !== undefined && <span>#{node.params.seed}</span>}
            {node?.result?.cost ? <span>${node.result.cost.toFixed(4)}</span> : <span />}
          </div>
        </div>

        {/* Hover actions — also stop pointerdown so dragging never starts here */}
        <div
          className="absolute right-1 top-1 flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            title="Add a child edit"
            className="flex h-5 w-5 items-center justify-center rounded bg-bg/80 text-text backdrop-blur hover:bg-accent hover:text-accent-contrast"
            onClick={(e) => {
              e.stopPropagation();
              onAdd();
            }}
          >
            <Plus className="h-3 w-3" />
          </button>
          <button
            type="button"
            title="Split — diverge into parallel edits"
            className="flex h-5 w-5 items-center justify-center rounded bg-bg/80 text-text backdrop-blur hover:bg-accent hover:text-accent-contrast"
            onClick={(e) => {
              e.stopPropagation();
              onSplit();
            }}
          >
            <GitFork className="h-3 w-3" />
          </button>
          {!isRoot && onDelete && (
            <button
              type="button"
              title="Delete this branch"
              className="flex h-5 w-5 items-center justify-center rounded bg-bg/80 text-text backdrop-blur hover:bg-down hover:text-white"
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
            >
              <Trash2 className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The focus tree canvas: source at the root, edit nodes fanning out to the right.
 * Nodes auto-arrange in a tidy tree, can be **dragged anywhere** on the canvas
 * (positions persist; "auto" re-tidies), and the engine underneath still runs the
 * whole graph in parallel. Bezier edges follow the cards live.
 */
export function FocusTree({ onUpload }: { onUpload: (file: File) => void }) {
  const nodes = useFocus((s) => s.nodes);
  const sourceHash = useFocus((s) => s.sourceHash);
  const rootPos = useFocus((s) => s.rootPos);
  const addEdit = useFocus((s) => s.addEdit);
  const split = useFocus((s) => s.split);
  const removeNode = useFocus((s) => s.removeNode);
  const moveNode = useFocus((s) => s.moveNode);
  const moveRoot = useFocus((s) => s.moveRoot);
  const autoArrange = useFocus((s) => s.autoArrange);
  const select = useFocus((s) => s.select);

  const [zoom, setZoom] = useState(1);
  const scrollerRef = useRef<HTMLDivElement>(null);

  // Track known node ids so freshly created cards (a split landing to the right)
  // can scroll into view — but a page load with persisted nodes never scrolls.
  const knownIds = useRef<Set<string> | null>(null);
  if (knownIds.current === null) knownIds.current = new Set(nodes.map((n) => n.id));

  const auto = useMemo(
    () =>
      layoutTree(
        nodes.map((n) => ({ id: n.id, parentId: n.parentId })),
        SOURCE_NODE_ID,
      ),
    [nodes],
  );

  // Effective position per id: manual override wins, auto layout otherwise.
  const positions = useMemo(() => {
    const map = new Map(auto.positions);
    if (rootPos) map.set(SOURCE_NODE_ID, rootPos);
    for (const n of nodes) if (n.position) map.set(n.id, n.position);
    return map;
  }, [auto, rootPos, nodes]);

  // Canvas bounds: the auto layout extended to cover any manually dragged cards.
  const size = useMemo(() => {
    let w = auto.width;
    let h = auto.height;
    for (const [, p] of positions) {
      w = Math.max(w, p.x + CARD_W);
      h = Math.max(h, p.y + CARD_H);
    }
    return { w, h };
  }, [auto, positions]);

  // Reveal freshly added cards if they're outside the viewport.
  useLayoutEffect(() => {
    const fresh = nodes.filter((n) => !knownIds.current!.has(n.id));
    knownIds.current = new Set(nodes.map((n) => n.id));
    if (!fresh.length || fresh.length > 4) return; // bulk (reload/reset) → no scroll
    const el = scrollerRef.current;
    const pos = positions.get(fresh[0]!.id);
    if (!el || !pos) return;
    const visX = pos.x * zoom >= el.scrollLeft - 16 && (pos.x + CARD_W) * zoom <= el.scrollLeft + el.clientWidth - 16;
    const visY = pos.y * zoom >= el.scrollTop - 16 && (pos.y + CARD_H) * zoom <= el.scrollTop + el.clientHeight - 16;
    if (visX && visY) return;
    el.scrollTo({
      left: Math.max(0, Math.min(pos.x * zoom - (el.clientWidth - CARD_W * zoom) / 2, el.scrollWidth - el.clientWidth)),
      top: Math.max(0, Math.min(pos.y * zoom - (el.clientHeight - CARD_H * zoom) / 2, el.scrollHeight - el.clientHeight)),
      behavior: "smooth",
    });
  }, [nodes, positions, zoom]);

  const fit = () => {
    const el = scrollerRef.current;
    if (!el) return;
    const scale = Math.min((el.clientWidth - 48) / size.w, (el.clientHeight - 48) / size.h, 1);
    setZoom(Math.max(0.2, scale));
  };

  useLayoutEffect(() => {
    if (nodes.length === 0) setZoom(1);
  }, [nodes.length]);

  // ── Drag state ──────────────────────────────────────────────────────────────
  const dragRef = useRef<{
    id: string;
    isRoot: boolean;
    startClientX: number;
    startClientY: number;
    origX: number;
    origY: number;
  } | null>(null);

  const startDrag = (id: string, isRoot: boolean) => (e: React.PointerEvent) => {
    const pos = positions.get(id) ?? { x: 0, y: 0 };
    dragRef.current = {
      id,
      isRoot,
      startClientX: e.clientX,
      startClientY: e.clientY,
      origX: pos.x,
      origY: pos.y,
    };
    // Selecting on grab means the dragged card lands in the inspector.
    if (!isRoot) select(id);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onDragMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = (e.clientX - d.startClientX) / zoom;
    const dy = (e.clientY - d.startClientY) / zoom;
    const pos = { x: d.origX + dx, y: d.origY + dy };
    if (d.isRoot) moveRoot(pos);
    else moveNode(d.id, pos);
  };

  const endDrag = () => {
    dragRef.current = null;
  };

  const inner = (n: FocusNode | null) => {
    const pos = positions.get(n ? n.id : SOURCE_NODE_ID);
    return pos ?? { x: 0, y: 0 };
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      {/* Zoom strip */}
      <div className="flex items-center justify-end gap-0.5 border-b border-border px-2 py-1">
        <IconButton
          label="Auto-arrange (tidy tree)"
          onClick={autoArrange}
          title="Return all cards to the auto tree layout"
        >
          <LayoutGrid className="h-3.5 w-3.5" />
        </IconButton>
        <div className="mx-1 h-4 w-px bg-border" />
        <IconButton label="Zoom out" onClick={() => setZoom((z) => Math.max(0.2, z - 0.1))}>
          <ZoomOut className="h-3.5 w-3.5" />
        </IconButton>
        <span className="w-10 text-center font-mono text-[10px] text-faint">
          {Math.round(zoom * 100)}%
        </span>
        <IconButton label="Zoom in" onClick={() => setZoom((z) => Math.min(1.6, z + 0.1))}>
          <ZoomIn className="h-3.5 w-3.5" />
        </IconButton>
        <IconButton label="Fit to view" onClick={fit}>
          <Maximize2 className="h-3.5 w-3.5" />
        </IconButton>
      </div>

      <div
        ref={scrollerRef}
        className="min-h-0 flex-1 overflow-auto"
        onPointerMove={onDragMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        {!sourceHash ? (
          /* Empty state — nothing to iterate without a source. */
          <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-elevated text-faint">
              <Upload className="h-5 w-5" />
            </div>
            <p className="text-sm font-medium text-muted">Focus on one image</p>
            <p className="max-w-xs text-xs leading-relaxed text-faint">
              Start from an upload or a library asset, then grow an edit tree — each node a
              targeted change, every branch explored in parallel.
            </p>
            <label className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md bg-accent px-3 text-xs font-medium text-accent-contrast hover:bg-accent-hover">
              <Upload className="h-3.5 w-3.5" />
              Upload an image
              <input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) onUpload(f);
                  e.target.value = "";
                }}
              />
            </label>
          </div>
        ) : (
          <div
            className="relative"
            style={{
              width: size.w * zoom + 64,
              height: size.h * zoom + 64,
              margin: 16,
            }}
          >
            <div
              className="relative"
              style={{
                width: size.w,
                height: size.h,
                transform: `scale(${zoom})`,
                transformOrigin: "0 0",
              }}
            >
              {/* Edges */}
              <svg
                className="pointer-events-none absolute inset-0"
                width={size.w}
                height={size.h}
              >
                {nodes.map((n) => {
                  const from = inner(n.parentId ? nodes.find((p) => p.id === n.parentId) ?? null : null);
                  const to = inner(n);
                  const x1 = from.x + CARD_W;
                  const y1 = from.y + CARD_H / 2;
                  const x2 = to.x;
                  const y2 = to.y + CARD_H / 2;
                  const mid = Math.max(x1 + 24, (x1 + x2) / 2);
                  return (
                    <path
                      key={n.id}
                      d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`}
                      fill="none"
                      stroke="var(--v-border-strong)"
                      strokeWidth={1.5}
                    />
                  );
                })}
              </svg>

              {/* Source root */}
              <TreeCard
                node={null}
                isRoot
                x={inner(null).x}
                y={inner(null).y}
                onAdd={() => addEdit(null)}
                onSplit={() => split(null, 3)}
                onDragStart={startDrag(SOURCE_NODE_ID, true)}
              />

              {/* Edit nodes */}
              {nodes.map((n) => (
                <TreeCard
                  key={n.id}
                  node={n}
                  isRoot={false}
                  x={inner(n).x}
                  y={inner(n).y}
                  onAdd={() => addEdit(n.id)}
                  onSplit={() => split(n.id, 3)}
                  onDelete={() => removeNode(n.id)}
                  onDragStart={startDrag(n.id, false)}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
