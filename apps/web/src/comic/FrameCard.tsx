import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  ChevronRight,
  Dices,
  Link2,
  Play,
  Star,
  Trash2,
  X,
} from "lucide-react";
import {
  buildAssistContext,
  frameImageHash,
  styleReferences,
  type ComicFrame,
} from "@vengine/shared";
import { useComic } from "../comicStore";
import { useStudio } from "../store";
import { api } from "../api";
import type { NodeRunStatus } from "../types";
import { Card, IconButton, Input, Select } from "../components/ui";
import { AssistTextarea } from "./AssistTextarea";
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
    removeVariant,
    displayHash,
    running,
    liveStatus,
    finalPrompt,
    addStyleRefFromFrame,
    toggleFrameCharacter,
    addCharacterRefFromFrame,
    setFrameContinuation,
  } = useComic();
  const openLightbox = useStudio((s) => s.openLightbox);
  const project = useComic((s) => s.project);
  const cast = project?.cast ?? [];
  const [showFinal, setShowFinal] = useState(false);
  /** A frame with no explicit list shows the whole cast (undefined = all). */
  const inFrame = (charId: string) =>
    frame.characterIds === undefined || frame.characterIds.includes(charId);
  const charLabel = (c: { name: string }, i: number) => c.name.trim() || `C${i + 1}`;

  const previewHash = displayHash(frame);
  const status: NodeRunStatus = liveStatus[frame.id] ?? (previewHash ? "done" : "pending");

  // Keep the freshest image in view: scroll this frame into the viewport whenever
  // a new preview streams in for it during a run.
  const cardRef = useRef<HTMLDivElement>(null);
  const livePreviewHash = useComic((s) => s.livePreview[frame.id]);
  useEffect(() => {
    if (!livePreviewHash) return;
    cardRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
  }, [livePreviewHash]);

  // One-shot border-sweep + brightness pop when a frame finishes generating.
  const [justRendered, setJustRendered] = useState(false);
  const prevStatus = useRef(status);
  useEffect(() => {
    const was = prevStatus.current;
    prevStatus.current = status;
    const becameRendered =
      (status === "done" || status === "cached") &&
      (was === "running" || was === "queued");
    if (!becameRendered) return;
    setJustRendered(true);
    // A cached frame streams no preview, so scroll it into view here instead.
    cardRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
    // Slightly longer than the longest CSS animation (border sweep ≈ 2.55s).
    const t = setTimeout(() => setJustRendered(false), 2700);
    return () => clearTimeout(t);
  }, [status]);
  // Is this frame's displayed image currently one of the project's style references?
  const isStyleRef = useComic(
    (s) =>
      !!previewHash &&
      !!s.project &&
      styleReferences(s.project.style).some((r) => r.hash === previewHash),
  );
  // Scene continuity: the frame this one continues, and its current still (if any).
  const continuesSource = frame.continuesFrameId
    ? project?.frames.find((f) => f.id === frame.continuesFrameId)
    : undefined;
  const continuesThumb = continuesSource ? frameImageHash(continuesSource) : undefined;

  return (
    <Card
      ref={cardRef}
      className="flex w-56 shrink-0 flex-col gap-2 p-3 shadow-lg shadow-black/20 ring-1 ring-border"
    >
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
        <div className="group/preview relative">
          <button
            type="button"
            onClick={() => openLightbox(previewHash)}
            className={cn(
              "group relative block aspect-[9/16] w-full overflow-hidden rounded-md ring-1 ring-inset ring-white/5",
              justRendered && "frame-reveal",
            )}
            title="Click to preview full size"
          >
            <img
              src={api.thumbUrl(previewHash)}
              alt={`frame ${index + 1}`}
              className="h-full w-full cursor-zoom-in object-cover"
            />
            {isStyleRef && (
              <span className="absolute left-1.5 top-1.5 flex items-center gap-1 rounded bg-accent/90 px-1.5 py-0.5 text-[9px] font-semibold text-accent-contrast">
                <Star className="h-2.5 w-2.5 fill-current" />
                style ref
              </span>
            )}
          </button>
          {/* Delete this generated image (drops it from the frame's history). */}
          <button
            type="button"
            onClick={() => void removeVariant(frame.id, previewHash)}
            disabled={running}
            aria-label="Delete this image"
            title="Delete this image"
            className="absolute right-1.5 top-1.5 rounded-full bg-black/55 p-1 text-white/85 opacity-0 transition hover:bg-down hover:text-white focus-visible:opacity-100 group-hover/preview:opacity-100 disabled:cursor-not-allowed disabled:opacity-0"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
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
              <div key={v.hash} className="group/var relative shrink-0">
                <button
                  type="button"
                  onClick={() => selectVariant(frame.id, v)}
                  title={`seed ${v.seed}`}
                  className={cn(
                    "block h-12 w-9 overflow-hidden rounded ring-1 transition",
                    selected ? "ring-2 ring-accent" : "ring-border hover:ring-border-strong",
                  )}
                >
                  <img
                    src={api.thumbUrl(v.hash)}
                    alt={`variant seed ${v.seed}`}
                    className="h-full w-full object-cover"
                  />
                </button>
                <button
                  type="button"
                  onClick={() => void removeVariant(frame.id, v.hash)}
                  disabled={running}
                  aria-label={`Delete variant seed ${v.seed}`}
                  title="Delete this image"
                  className="absolute right-0 top-0 rounded-bl rounded-tr bg-black/65 p-0.5 text-white/85 opacity-0 transition hover:bg-down hover:text-white group-hover/var:opacity-100 disabled:cursor-not-allowed disabled:opacity-0"
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              </div>
            );
          })}
        </div>
      )}

      <AssistTextarea
        field="framePrompt"
        autoGrow
        expandable
        editorTitle={`Frame ${index + 1} · scene`}
        placeholder="Describe this frame's scene…"
        value={frame.prompt}
        onValueChange={(v) => patchFrame(frame.id, { prompt: v })}
        context={project ? buildAssistContext(project, "framePrompt", frame) : undefined}
      />

      {/* Which cast members appear in this frame (drives identity references). */}
      {cast.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {cast.map((c, i) => {
            const active = inFrame(c.id);
            const label = charLabel(c, i);
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => toggleFrameCharacter(frame.id, c.id)}
                title={
                  active
                    ? `${label} appears in this frame — click to exclude`
                    : `Add ${label} to this frame`
                }
                className={cn(
                  "rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors",
                  active
                    ? "bg-accent-soft text-accent ring-1 ring-accent/40"
                    : "bg-elevated text-faint hover:text-muted",
                )}
              >
                {label}
              </button>
            );
          })}
        </div>
      )}

      {/* Scene continuity — mark THIS frame as continued from another frame; that
          source frame's image is fed in as the strongest reference when this frame
          generates (same setting/light, new action). */}
      {total > 1 && (
        <div className="flex items-center gap-1.5">
          <Link2 className="h-3.5 w-3.5 shrink-0 text-faint" />
          <Select
            className="flex-1"
            value={frame.continuesFrameId ?? ""}
            onChange={(e) => setFrameContinuation(frame.id, e.target.value || null)}
            title="Make this frame a continuation of another frame's scene — that frame's image is fed in as the strongest reference when generating this one"
          >
            <option value="">not a continuation</option>
            {(project?.frames ?? []).map((f, i) =>
              f.id === frame.id ? null : (
                <option key={f.id} value={f.id}>
                  continued from Frame {i + 1}
                </option>
              ),
            )}
          </Select>
          {continuesThumb && (
            <img
              src={api.thumbUrl(continuesThumb)}
              alt="scene this frame is continued from"
              className="h-8 w-[18px] shrink-0 rounded object-cover ring-1 ring-accent/40"
              title="The scene this frame is continued from"
            />
          )}
        </div>
      )}

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
            onClick={() => addStyleRefFromFrame(frame.id)}
            className="flex items-center gap-1 text-faint hover:text-accent"
            title="Add this frame's image as a style reference for all frames"
          >
            <Star className="h-3 w-3" />
            as style ref
          </button>
        )}
      </div>
      {showFinal && (
        <pre className="max-h-28 overflow-y-auto whitespace-pre-wrap rounded-md border border-border bg-bg p-2 text-[10px] leading-relaxed text-muted">
          {finalPrompt(frame)}
        </pre>
      )}

      {/* "Character sheet" shortcut: bank this frame's image as a character's ref. */}
      {frame.resultHash && cast.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 text-[10px] text-faint">
          <span>as ref →</span>
          {cast.map((c, i) => (
            <button
              key={c.id}
              type="button"
              onClick={() => addCharacterRefFromFrame(c.id, frame.id)}
              className="rounded bg-elevated px-1.5 py-0.5 transition-colors hover:text-accent"
              title={`Use this image as a reference for ${charLabel(c, i)}`}
            >
              {charLabel(c, i)}
            </button>
          ))}
        </div>
      )}
    </Card>
  );
}
