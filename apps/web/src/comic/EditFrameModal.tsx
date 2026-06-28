import { useEffect, useRef, useState } from "react";
import { Loader2, Sparkles, Upload, Wand2, X } from "lucide-react";
import { buildAssistContext, frameImageHash } from "@vengine/shared";
import { useComic } from "../comicStore";
import { api } from "../api";
import { Button, Input, Segmented } from "../components/ui";
import { AssistTextarea } from "./AssistTextarea";
import { cn } from "@/lib/cn";

interface Props {
  frameId: string;
  index: number;
  onClose: () => void;
}

const MODE_OPTIONS = [
  { value: "tweak" as const, label: "Tweak" },
  { value: "restage" as const, label: "Re-stage" },
];

const MODE_HINT: Record<"tweak" | "restage", string> = {
  tweak: "Change only what you describe — keep the same composition, camera, lighting & style.",
  restage: "Keep the look & characters, but allow a new camera angle, pose or composition.",
};

/**
 * In-place image editor for one frame: pick a base image (a past variant or a fresh
 * upload), describe the change, and generate an edit-model pass that keeps the look
 * while applying the tweak. Each generate appends a new selected variant; the base
 * follows the latest result so edits chain naturally (edit → edit-the-edit → …).
 */
export function EditFrameModal({ frameId, index, onClose }: Props) {
  const frame = useComic((s) => s.project?.frames.find((f) => f.id === frameId));
  const project = useComic((s) => s.project);
  const models = useComic((s) => s.models);
  const editFrame = useComic((s) => s.editFrame);
  const displayHash = useComic((s) => s.displayHash);
  const livePreview = useComic((s) => s.livePreview[frameId]);
  const busy = useComic((s) => s.inFlight.includes(frameId));

  const current = frame ? displayHash(frame) : undefined;
  const [baseHash, setBaseHash] = useState<string | undefined>(current);
  const [instruction, setInstruction] = useState("");
  const [mode, setMode] = useState<"tweak" | "restage">("tweak");
  const [keepStyle, setKeepStyle] = useState(true);
  const [lockSeed, setLockSeed] = useState(false);
  const [seed, setSeed] = useState<number | "">("");
  const [uploading, setUploading] = useState(false);
  // Tracks the result hash before a generate, so we can re-home the base onto the
  // fresh output once the edit lands (without stomping a manual base pick mid-run).
  const pendingFrom = useRef<string | undefined>(undefined);

  // Esc closes (the edit, if running, keeps streaming to the card behind us).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // When an edit finishes, the frame gains a new selected result — adopt it as the
  // next base so the artist iterates on the latest image, not the original.
  useEffect(() => {
    if (busy || !pendingFrom.current || !frame) return;
    const latest = frameImageHash(frame);
    if (latest && latest !== pendingFrom.current) setBaseHash(latest);
    pendingFrom.current = undefined;
  }, [busy, frame]);

  if (!frame || !project) return null;

  const model = models.find((m) => m.id === project.style.model);
  // Unknown model id (custom) → can't confirm; only warn when we positively know it
  // ignores references (an edit then silently degrades to a plain text-to-image).
  const noEditSupport = !!model && !model.consumesReferences;

  // Base options: every variant, plus the current base if it's an upload not in history.
  const variantHashes = frame.variants.map((v) => v.hash);
  const baseOptions =
    baseHash && !variantHashes.includes(baseHash) ? [baseHash, ...variantHashes] : variantHashes;

  // The big canvas shows the live edit while running, else the chosen base.
  const previewHash = livePreview ?? baseHash ?? current;

  const onUploadBase = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setUploading(true);
    try {
      const ref = await api.uploadAsset(file);
      setBaseHash(ref.hash);
    } catch {
      /* surfaced by the global toaster via uploadAsset's caller paths */
    } finally {
      setUploading(false);
    }
  };

  const canGenerate = !!baseHash && !!instruction.trim() && !busy && !noEditSupport;

  const onGenerate = () => {
    if (!canGenerate || !baseHash) return;
    pendingFrom.current = frameImageHash(frame);
    void editFrame(frameId, {
      baseHash,
      instruction: instruction.trim(),
      mode,
      keepStyle,
      ...(lockSeed && seed !== "" ? { seed: Number(seed) } : {}),
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm sm:p-6"
      onMouseDown={onClose}
    >
      <div
        className="flex max-h-full w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-2xl shadow-black/40"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
          <span className="flex items-center gap-2 text-sm font-semibold text-text">
            <Wand2 className="h-4 w-4 text-accent" />
            Edit image · Frame {index + 1}
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close editor"
            title="Close (Esc)"
            className="text-faint transition-colors hover:text-text"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto p-4 sm:flex-row">
          {/* Canvas — the base, or the live edit while it streams in. */}
          <div className="relative mx-auto w-full max-w-[280px] shrink-0 sm:mx-0 sm:w-64">
            <div className="relative aspect-[9/16] w-full overflow-hidden rounded-lg ring-1 ring-inset ring-white/5">
              {previewHash ? (
                <img
                  src={api.thumbUrl(previewHash)}
                  alt={`frame ${index + 1} base`}
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center text-[11px] text-faint">
                  no image yet
                </div>
              )}
              {busy && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/45 text-[11px] font-medium text-white backdrop-blur-[1px]">
                  <Loader2 className="h-5 w-5 animate-spin" />
                  applying edit…
                </div>
              )}
            </div>

            {/* Base picker — choose which image to edit from, or upload a new one. */}
            <div className="mt-2 flex gap-1.5 overflow-x-auto pb-0.5">
              {baseOptions.map((hash) => (
                <button
                  key={hash}
                  type="button"
                  onClick={() => setBaseHash(hash)}
                  title={hash === current ? "Current image" : "Use as base"}
                  className={cn(
                    "block h-12 w-9 shrink-0 overflow-hidden rounded ring-1 transition",
                    hash === baseHash
                      ? "ring-2 ring-accent"
                      : "ring-border hover:ring-border-strong",
                  )}
                >
                  <img src={api.thumbUrl(hash)} alt="base option" className="h-full w-full object-cover" />
                </button>
              ))}
              <label
                title="Upload an image to edit from"
                className="flex h-12 w-9 shrink-0 cursor-pointer items-center justify-center rounded ring-1 ring-dashed ring-border text-faint transition hover:text-accent hover:ring-accent/60"
              >
                <input type="file" accept="image/*" className="hidden" disabled={busy || uploading} onChange={onUploadBase} />
                {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
              </label>
            </div>
          </div>

          {/* Controls. */}
          <div className="flex min-w-0 flex-1 flex-col gap-3">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted">Describe the change</label>
              <AssistTextarea
                field="framePrompt"
                resizable
                expandable
                editorTitle={`Frame ${index + 1} · edit instruction`}
                placeholder="e.g. she leans back in her chair, arms crossed; shift to a lower camera angle"
                value={instruction}
                onValueChange={setInstruction}
                context={project ? buildAssistContext(project, "framePrompt", frame) : undefined}
                className="min-h-24"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted">How much to change</label>
              <Segmented value={mode} onChange={setMode} options={MODE_OPTIONS} size="sm" />
              <p className="text-[11px] leading-relaxed text-faint">{MODE_HINT[mode]}</p>
            </div>

            <label className="flex items-start gap-2 text-xs text-muted">
              <input
                type="checkbox"
                checked={keepStyle}
                onChange={(e) => setKeepStyle(e.target.checked)}
                className="mt-0.5 h-3.5 w-3.5 accent-accent"
              />
              <span>
                Keep style &amp; characters
                <span className="block text-[11px] text-faint">
                  Also feed the project's style references and this frame's cast, so the look stays consistent.
                </span>
              </span>
            </label>

            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1.5 text-xs text-muted">
                <input
                  type="checkbox"
                  checked={lockSeed}
                  onChange={(e) => setLockSeed(e.target.checked)}
                  className="h-3.5 w-3.5 accent-accent"
                />
                Lock seed
              </label>
              <Input
                type="number"
                className="h-7 w-28 text-xs"
                placeholder="random"
                disabled={!lockSeed}
                value={seed}
                onChange={(e) => setSeed(e.target.value === "" ? "" : Number(e.target.value))}
                title="Reuse a fixed seed to reproduce an edit; leave unlocked to explore variations"
              />
            </div>

            {noEditSupport && (
              <p className="rounded-md bg-amber/10 px-2.5 py-2 text-[11px] leading-relaxed text-amber ring-1 ring-amber/30">
                <strong>{model?.displayName ?? project.style.model}</strong> doesn't apply reference
                images, so it can't edit in place. Pick an edit-capable model (e.g. Nano Banana Pro or
                FLUX.2 [pro]) in Style to use this.
              </p>
            )}

            <div className="mt-auto flex items-center justify-end gap-2 pt-1">
              <Button variant="ghost" size="lg" onClick={onClose}>
                Close
              </Button>
              <Button variant="accent" size="lg" onClick={onGenerate} disabled={!canGenerate}>
                {busy ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Editing…
                  </>
                ) : (
                  <>
                    <Sparkles className="h-3.5 w-3.5" />
                    Generate edit
                  </>
                )}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
