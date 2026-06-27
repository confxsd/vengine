import { useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  ChevronRight,
  Dices,
  Play,
  Star,
  X,
} from "lucide-react";
import type { ComicFrame } from "@vengine/shared";
import { useComic } from "../comicStore";
import { useStudio } from "../store";
import { api } from "../api";
import type { NodeRunStatus } from "../types";
import { Card, IconButton, Input, Textarea } from "../components/ui";
import { cn } from "@/lib/cn";

const STATUS_DOT: Record<NodeRunStatus, string> = {
  pending: "bg-faint/50",
  queued: "bg-faint animate-pulse",
  running: "bg-amber animate-pulse",
  cached: "bg-cyan",
  done: "bg-up",
  error: "bg-down",
  skipped: "bg-faint/30",
};

interface Props {
  frame: ComicFrame;
  index: number;
  total: number;
}

export function FrameCard({ frame, index, total }: Props) {
  const {
    patchFrame,
    removeFrame,
    moveFrame,
    runOne,
    varyFrame,
    selectVariant,
    displayHash,
    running,
    liveStatus,
    finalPrompt,
    setAnchorFromFrame,
  } = useComic();
  const openLightbox = useStudio((s) => s.openLightbox);
  const [showFinal, setShowFinal] = useState(false);

  const previewHash = displayHash(frame);
  const status: NodeRunStatus = liveStatus[frame.id] ?? (previewHash ? "done" : "pending");
  const anchorHash = useComic((s) => s.project?.style.anchorHash);
  const isAnchor = !!previewHash && anchorHash === previewHash;

  return (
    <Card className="flex w-56 shrink-0 flex-col gap-2 p-3 shadow-lg shadow-black/20 ring-1 ring-border">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-muted">
          Frame {index + 1}
        </span>
        <div className="flex items-center gap-0.5">
          <span
            className={cn("mr-1 h-2 w-2 rounded-full", STATUS_DOT[status])}
            title={status}
          />
          <IconButton
            size="icon-sm"
            label="Move left"
            onClick={() => moveFrame(frame.id, -1)}
            disabled={index === 0}
          >
            <ArrowLeft className="h-3.5 w-3.5" />
          </IconButton>
          <IconButton
            size="icon-sm"
            label="Move right"
            onClick={() => moveFrame(frame.id, 1)}
            disabled={index === total - 1}
          >
            <ArrowRight className="h-3.5 w-3.5" />
          </IconButton>
          <IconButton
            size="icon-sm"
            label="Remove frame"
            className="hover:text-down"
            onClick={() => removeFrame(frame.id)}
          >
            <X className="h-3.5 w-3.5" />
          </IconButton>
        </div>
      </div>

      {/* 9:16 preview */}
      {previewHash ? (
        <button
          type="button"
          onClick={() => openLightbox(previewHash)}
          className="group relative block aspect-[9/16] w-full overflow-hidden rounded-md ring-1 ring-inset ring-white/5"
          title="Click to preview full size"
        >
          <img
            src={api.thumbUrl(previewHash)}
            alt={`frame ${index + 1}`}
            className="h-full w-full cursor-zoom-in object-cover"
          />
          {isAnchor && (
            <span className="absolute left-1.5 top-1.5 flex items-center gap-1 rounded bg-accent/90 px-1.5 py-0.5 text-[9px] font-semibold text-accent-contrast">
              <Star className="h-2.5 w-2.5 fill-current" />
              anchor
            </span>
          )}
        </button>
      ) : (
        <div className="flex aspect-[9/16] w-full items-center justify-center rounded-md border border-dashed border-border text-[10px] text-faint">
          {status === "queued" || status === "running"
            ? "generating…"
            : "no image yet"}
        </div>
      )}

      {/* Variant history — pick a past iteration to restore its image + seed. */}
      {frame.variants.length > 1 && (
        <div className="flex gap-1 overflow-x-auto pb-0.5">
          {frame.variants.map((v) => {
            const selected = v.hash === previewHash;
            return (
              <button
                key={v.hash}
                type="button"
                onClick={() => selectVariant(frame.id, v)}
                title={`seed ${v.seed}`}
                className={cn(
                  "h-12 w-9 shrink-0 overflow-hidden rounded ring-1 transition",
                  selected ? "ring-2 ring-accent" : "ring-border hover:ring-border-strong",
                )}
              >
                <img
                  src={api.thumbUrl(v.hash)}
                  alt={`variant seed ${v.seed}`}
                  className="h-full w-full object-cover"
                />
              </button>
            );
          })}
        </div>
      )}

      <Textarea
        className="h-20"
        placeholder="Describe this frame's scene…"
        value={frame.prompt}
        onChange={(e) => patchFrame(frame.id, { prompt: e.target.value })}
      />

      <div className="flex items-center gap-2">
        <Input
          className="flex-1"
          type="number"
          placeholder="seed (auto)"
          value={frame.seed ?? ""}
          onChange={(e) =>
            patchFrame(frame.id, {
              seed: e.target.value === "" ? undefined : Number(e.target.value),
            })
          }
          title="Per-frame seed override (defaults to the project's locked seed)"
        />
        <IconButton
          variant="secondary"
          label="Vary — regenerate with a fresh random seed"
          onClick={() => varyFrame(frame.id)}
          disabled={running}
        >
          <Dices className="h-3.5 w-3.5" />
        </IconButton>
        <IconButton
          variant="accent"
          label="Generate just this frame"
          onClick={() => runOne(frame.id)}
          disabled={running}
        >
          <Play className="h-3.5 w-3.5 fill-current" />
        </IconButton>
      </div>

      <div className="flex items-center justify-between text-[10px]">
        <button
          onClick={() => setShowFinal((v) => !v)}
          className="flex items-center gap-0.5 text-faint hover:text-muted"
        >
          {showFinal ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )}
          final prompt
        </button>
        {frame.resultHash && (
          <button
            onClick={() => setAnchorFromFrame(frame.id)}
            className="flex items-center gap-1 text-faint hover:text-accent"
            title="Use this frame as the style anchor for all frames"
          >
            <Star className="h-3 w-3" />
            set as anchor
          </button>
        )}
      </div>
      {showFinal && (
        <pre className="max-h-28 overflow-y-auto whitespace-pre-wrap rounded-md border border-border bg-bg p-2 text-[10px] leading-relaxed text-muted">
          {finalPrompt(frame)}
        </pre>
      )}
    </Card>
  );
}
