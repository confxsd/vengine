import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  Dices,
  ImagePlus,
  Library,
  Link2,
  Loader2,
  Play,
  Star,
  Trash2,
  Upload,
  Wand2,
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
import { Card, IconButton, Input, Segmented, Select } from "../components/ui";
import { AssistTextarea } from "./AssistTextarea";
import { EditFrameModal } from "./EditFrameModal";
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
    uploadFrameOutput,
    displayHash,
    liveStatus,
    finalPrompt,
    addStyleRefFromFrame,
    toggleFrameCharacter,
    addCharacterRefFromFrame,
    uploadFrameRef,
    addFrameRefFromLibrary,
    removeFrameRef,
    setFrameContinuation,
    selectedFrameIds,
    toggleFrameSelected,
    inFlight,
  } = useComic();
  const selected = selectedFrameIds.includes(frame.id);
  /** This frame is mid-generation — disable its own controls, but not others'. */
  const busy = inFlight.includes(frame.id);
  const openLightbox = useStudio((s) => s.openLightbox);
  const project = useComic((s) => s.project);
  const cast = project?.cast ?? [];
  const [showFinal, setShowFinal] = useState(false);
  const [editing, setEditing] = useState(false);
  const [showRefPicker, setShowRefPicker] = useState(false);
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

  // Keep the newest output in view: variants append to the end of the
  // horizontally-scrolling strip, so scroll it fully right when one is added.
  const variantStripRef = useRef<HTMLDivElement>(null);
  const variantCount = frame.variants.length;
  useEffect(() => {
    const strip = variantStripRef.current;
    if (strip) strip.scrollTo({ left: strip.scrollWidth, behavior: "smooth" });
  }, [variantCount]);

  // One-shot border-sweep + brightness pop when a frame finishes generating.
  const [justRendered, setJustRendered] = useState(false);
  const prevStatus = useRef(status);
  // The reset timer lives in a ref, NOT the effect's cleanup: a run settles in two
  // status steps (e.g. a cache hit goes queued→cached→done once the live status is
  // cleared). If the cleanup cleared the timer on that second transition, the reveal
  // would never turn off — the border would animate forever. Clearing only on
  // unmount (and before re-arming) lets the timer survive the settle.
  const revealTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(revealTimer.current), []);
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
    clearTimeout(revealTimer.current);
    revealTimer.current = setTimeout(() => setJustRendered(false), 2700);
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

  const onUploadOutput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) void uploadFrameOutput(frame.id, file);
    e.target.value = ""; // allow re-selecting the same file
  };

  const onUploadRef = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) void uploadFrameRef(frame.id, file);
    e.target.value = "";
  };

  // Library images not already attached to this frame (the "+ from library" pool).
  const library = project?.library ?? [];
  const unattachedRefs = library.filter((a) => !frame.refHashes.includes(a.hash));

  // Whether this frame actually feeds identity/style references (its own refs, the
  // project style anchors, or an active cast member with refs). Drives the visibility
  // of the composition-mode control — it's inert otherwise.
  const styleRefCount = project ? styleReferences(project.style).length : 0;
  const activeCastHasRefs = cast.some((c) => inFrame(c.id) && c.refHashes.length > 0);
  const hasIdentityRefs = frame.refHashes.length > 0 || styleRefCount > 0 || activeCastHasRefs;
  // When a continuation is active its own mode governs composition, so the
  // reference-mode control would be redundant — mirror `composeFramePrompt`'s branch.
  const continuityActive = !!frame.continuesFrameId && !!continuesThumb;
  const referenceMode = frame.referenceMode ?? "compose";

  // Drag an image file onto the preview to set it as this frame's output.
  const [dragOver, setDragOver] = useState(false);
  const isFileDrag = (e: React.DragEvent) => e.dataTransfer.types.includes("Files");
  const onDragOver = (e: React.DragEvent) => {
    if (busy || !isFileDrag(e)) return;
    e.preventDefault(); // mark this a valid drop target
    setDragOver(true);
  };
  const onDragLeave = (e: React.DragEvent) => {
    // Ignore leaves into child elements; only clear when leaving the area entirely.
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDragOver(false);
  };
  const onDropFile = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (busy) return;
    const file = Array.from(e.dataTransfer.files).find((f) => f.type.startsWith("image/"));
    if (file) void uploadFrameOutput(frame.id, file);
  };

  return (
    <Card
      ref={cardRef}
      className={cn(
        "flex w-56 shrink-0 flex-col gap-2 p-3 shadow-lg shadow-black/20 ring-1",
        selected ? "ring-2 ring-accent" : "ring-border",
      )}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            role="checkbox"
            aria-checked={selected}
            onClick={() => toggleFrameSelected(frame.id)}
            title={selected ? "Unselect frame" : "Select frame for batch generation"}
            className={cn(
              "flex h-3.5 w-3.5 items-center justify-center rounded-[4px] ring-1 transition-colors",
              selected
                ? "bg-accent text-accent-contrast ring-accent"
                : "ring-border hover:ring-border-strong",
            )}
          >
            {selected && <Check className="h-2.5 w-2.5" strokeWidth={3} />}
          </button>
          <span className="text-xs font-semibold text-muted">
            Frame {index + 1}
          </span>
        </div>
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

      {/* 9:16 preview — drop an image anywhere on it to set it as the output. */}
      <div
        className="relative"
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDropFile}
      >
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
            disabled={busy}
            aria-label="Delete this image"
            title="Delete this image"
            className="absolute right-1.5 top-1.5 rounded-full bg-black/55 p-1 text-white/85 opacity-0 transition hover:bg-down hover:text-white focus-visible:opacity-100 group-hover/preview:opacity-100 disabled:cursor-not-allowed disabled:opacity-0"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
          {/* Image-to-image edit: iterate on THIS image (posture, camera, small fixes). */}
          <button
            type="button"
            onClick={() => setEditing(true)}
            disabled={busy}
            aria-label="Edit this image"
            title="Edit this image — tweak posture, camera angle, small fixes"
            className="absolute bottom-1.5 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full bg-accent/90 px-2.5 py-1 text-[10px] font-semibold text-accent-contrast opacity-0 shadow-lg shadow-black/30 transition hover:bg-accent focus-visible:opacity-100 group-hover/preview:opacity-100 disabled:cursor-not-allowed disabled:opacity-0"
          >
            <Wand2 className="h-3 w-3" />
            Edit
          </button>
          {/* While this frame regenerates it keeps showing its previous image, so
              overlay a clear "working" state — otherwise a 30-40s reference gen
              looks frozen (only the tiny status dot would change). */}
          {busy && (
            <div className="pointer-events-none absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 rounded-md bg-black/55 text-[11px] font-medium text-white backdrop-blur-[1px]">
              <Loader2 className="h-5 w-5 animate-spin" />
              {status === "queued" ? "queued…" : "generating…"}
            </div>
          )}
        </div>
      ) : status === "queued" || status === "running" ? (
        <div className="flex aspect-[9/16] w-full items-center justify-center rounded-md border border-dashed border-border text-[10px] text-faint">
          generating…
        </div>
      ) : (
        // No output (e.g. lost/never generated): let the artist upload one directly,
        // so other frames can be continued from this scene.
        <label className="flex aspect-[9/16] w-full cursor-pointer flex-col items-center justify-center gap-1 rounded-md border border-dashed border-border text-[10px] text-faint transition-colors hover:border-border-strong hover:text-muted">
          <input type="file" accept="image/*" className="hidden" disabled={busy} onChange={onUploadOutput} />
          <Upload className="h-4 w-4" />
          <span>upload output</span>
        </label>
      )}
        {dragOver && (
          <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-1 rounded-md bg-accent/20 text-[11px] font-medium text-accent ring-2 ring-inset ring-accent backdrop-blur-sm">
            <Upload className="h-5 w-5" />
            drop image
          </div>
        )}
      </div>

      {/* Variant history — pick a past iteration to restore its image + seed.
          The trailing tile uploads an image as an extra output (e.g. to restore a
          lost one, or seed a scene other frames continue from). */}
      {frame.variants.length > 0 && (
        <div ref={variantStripRef} className="flex gap-1 overflow-x-auto pb-0.5">
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
                  disabled={busy}
                  aria-label={`Delete variant seed ${v.seed}`}
                  title="Delete this image"
                  className="absolute right-0 top-0 rounded-bl rounded-tr bg-black/65 p-0.5 text-white/85 opacity-0 transition hover:bg-down hover:text-white group-hover/var:opacity-100 disabled:cursor-not-allowed disabled:opacity-0"
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              </div>
            );
          })}
          <label
            title="Upload an image as an output for this frame"
            className="flex h-12 w-9 shrink-0 cursor-pointer flex-col items-center justify-center rounded ring-1 ring-dashed ring-border text-faint transition hover:text-accent hover:ring-accent/60"
          >
            <input type="file" accept="image/*" className="hidden" disabled={busy} onChange={onUploadOutput} />
            <Upload className="h-3.5 w-3.5" />
          </label>
        </div>
      )}

      <AssistTextarea
        field="framePrompt"
        resizable
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

      {/* Per-frame reference images — steer ONLY this frame (composition/look
          guidance), independent of the project-wide style anchors and shared cast. */}
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-1">
          <span className="mr-0.5 text-[10px] font-medium uppercase tracking-wide text-faint">
            refs
          </span>
          {frame.refHashes.map((hash) => (
            <div key={hash} className="group/fref relative shrink-0">
              <img
                src={api.thumbUrl(hash)}
                alt="frame reference"
                className="h-9 w-9 rounded object-cover ring-1 ring-border"
                title="Reference for this frame only"
              />
              <button
                type="button"
                onClick={() => removeFrameRef(frame.id, hash)}
                aria-label="Remove this frame reference"
                title="Remove reference"
                className="absolute -right-1 -top-1 rounded-full bg-black/70 p-0.5 text-white/85 opacity-0 transition hover:bg-down hover:text-white group-hover/fref:opacity-100"
              >
                <X className="h-2.5 w-2.5" />
              </button>
            </div>
          ))}
          <label
            title="Upload an image as a reference for this frame"
            className="flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded ring-1 ring-dashed ring-border text-faint transition hover:text-accent hover:ring-accent/60"
          >
            <input type="file" accept="image/*" className="hidden" disabled={busy} onChange={onUploadRef} />
            <ImagePlus className="h-3.5 w-3.5" />
          </label>
          {unattachedRefs.length > 0 && (
            <button
              type="button"
              onClick={() => setShowRefPicker((v) => !v)}
              title="Attach a reference from the library"
              className={cn(
                "flex h-9 w-9 shrink-0 items-center justify-center rounded ring-1 transition",
                showRefPicker
                  ? "text-accent ring-accent/60"
                  : "text-faint ring-dashed ring-border hover:text-accent hover:ring-accent/60",
              )}
            >
              <Library className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        {showRefPicker && unattachedRefs.length > 0 && (
          <div className="grid grid-cols-5 gap-1 rounded-md border border-border bg-bg p-1.5">
            {unattachedRefs.map((a) => (
              <button
                key={a.hash}
                type="button"
                onClick={() => addFrameRefFromLibrary(frame.id, a.hash)}
                title={a.label ? `Attach “${a.label}”` : "Attach to this frame"}
                className="block aspect-square overflow-hidden rounded ring-1 ring-border transition hover:ring-accent"
              >
                <img src={api.thumbUrl(a.hash)} alt={a.label || "library image"} className="h-full w-full object-cover" />
              </button>
            ))}
          </div>
        )}

        {/* Composition control: how the frame's identity/style references are used.
            Default "New" keeps look consistent while the prompt owns the camera &
            layout; "Match ref" reproduces the reference's composition. Hidden when a
            continuation governs composition, or no references are fed. */}
        {hasIdentityRefs && !continuityActive && (
          <div className="flex flex-col gap-1 pt-0.5">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-medium uppercase tracking-wide text-faint">
                composition
              </span>
              <Segmented
                size="sm"
                aria-label="How references steer this frame"
                value={referenceMode}
                onChange={(m) => patchFrame(frame.id, { referenceMode: m })}
                options={[
                  { value: "compose", label: "New" },
                  { value: "match", label: "Match ref" },
                ]}
              />
            </div>
            <p className="text-[10px] leading-relaxed text-faint">
              {referenceMode === "compose"
                ? "References lock character & style — your prompt drives the camera & layout."
                : "Reproduces the reference's composition & camera; the prompt only adds changes."}
            </p>
          </div>
        )}
      </div>

      {/* Scene continuity — mark THIS frame as continued from another frame; that
          source frame's image is fed in as the strongest reference when this frame
          generates. The mode tells the edit model how to use it: re-stage a new
          camera angle in the same scene, or edit that exact shot in place. */}
      {total > 1 && (
        <div className="flex flex-col gap-1.5">
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
          {/* Continuation intent — only meaningful once a source frame is linked. */}
          {frame.continuesFrameId && (
            <Select
              className="ml-5"
              value={frame.continuesMode ?? "restage"}
              onChange={(e) =>
                patchFrame(frame.id, { continuesMode: e.target.value as "shot" | "restage" })
              }
              title="How to use the linked frame: re-stage a new camera angle in the same scene (keeps setting, light, palette & characters), or edit that exact shot in place"
            >
              <option value="restage">↪ new angle (re-stage)</option>
              <option value="shot">↪ same shot (edit in place)</option>
            </Select>
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
          disabled={busy}
        >
          <Dices className="h-3.5 w-3.5" />
        </IconButton>
        <IconButton
          variant="accent"
          label="Generate just this frame"
          onClick={() => runOne(frame.id)}
          disabled={busy}
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

      {editing && (
        <EditFrameModal frameId={frame.id} index={index} onClose={() => setEditing(false)} />
      )}
    </Card>
  );
}
