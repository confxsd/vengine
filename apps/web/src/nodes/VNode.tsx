import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Maximize2 } from "lucide-react";
import { useStudio, type VNode as VNodeType } from "../store";
import { api } from "../api";
import type { NodeRunStatus } from "../types";
import { cn } from "@/lib/cn";

/** Category → accent dot color. Flat: a single colored dot, not a border bar. */
const CATEGORY_DOT: Record<string, string> = {
  generation: "text-accent",
  compositing: "text-cyan",
  io: "text-faint",
  logic: "text-amber",
  intelligence: "text-purple",
};

const STATUS_DOT: Record<NodeRunStatus, string> = {
  pending: "bg-faint/50",
  queued: "bg-faint",
  running: "bg-amber animate-pulse",
  cached: "bg-cyan",
  done: "bg-up",
  error: "bg-down",
  skipped: "bg-faint/30",
};

function portRowStyle(i: number, total: number): React.CSSProperties {
  // Distribute handles evenly along the node's vertical edge.
  const top = total === 1 ? 50 : 28 + i * (60 / Math.max(1, total - 1));
  return { top: `${top}%` };
}

export function VNode({ data, selected }: NodeProps<VNodeType>) {
  const openLightbox = useStudio((s) => s.openLightbox);
  const categoryDot = CATEGORY_DOT[data.category] ?? "text-faint";

  return (
    <div
      className={cn(
        "w-56 rounded-lg bg-card shadow-lg shadow-black/30 ring-1 transition-shadow",
        selected ? "ring-2 ring-accent" : "ring-border",
      )}
    >
      <div className="flex items-center gap-2 rounded-t-lg bg-elevated px-3 py-2">
        <span className={cn("holo-dot", categoryDot)} />
        <span className="min-w-0 flex-1 truncate text-xs font-semibold tracking-wide text-text">
          {data.title}
        </span>
        <span
          className={cn(
            "h-2 w-2 shrink-0 rounded-full",
            STATUS_DOT[data.status ?? "pending"],
          )}
          title={data.status ?? "pending"}
        />
      </div>

      <div className="relative px-3 py-3">
        {data.inputs.map((p, i) => (
          <Handle
            key={p.id}
            type="target"
            position={Position.Left}
            id={p.id}
            style={portRowStyle(i, data.inputs.length)}
          />
        ))}
        {data.outputs.map((p, i) => (
          <Handle
            key={p.id}
            type="source"
            position={Position.Right}
            id={p.id}
            style={portRowStyle(i, data.outputs.length)}
          />
        ))}

        {data.previewHash ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              openLightbox(data.previewHash!);
            }}
            title="Click to preview full size"
            className="nodrag group relative block w-full"
          >
            <img
              src={api.thumbUrl(data.previewHash)}
              alt="preview"
              className="aspect-square w-full cursor-zoom-in rounded-md object-cover ring-1 ring-inset ring-white/5"
            />
            <span className="pointer-events-none absolute bottom-1.5 right-1.5 flex items-center gap-1 rounded bg-black/70 px-1.5 py-0.5 text-[9px] text-white opacity-0 transition-opacity group-hover:opacity-100">
              <Maximize2 className="h-2.5 w-2.5" />
              preview
            </span>
          </button>
        ) : (
          <div className="flex aspect-square w-full items-center justify-center rounded-md border border-dashed border-border text-[10px] text-faint">
            {data.type}
          </div>
        )}

        {data.cost != null && (
          <div className="mt-2 text-right font-mono text-[10px] text-faint">
            ${data.cost.toFixed(4)}
          </div>
        )}

        {data.outputPath && (
          <div
            className="mt-1 truncate font-mono text-[9px] text-up/80"
            title={data.outputPath}
          >
            ✓ saved: {data.outputPath}
          </div>
        )}
      </div>
    </div>
  );
}
