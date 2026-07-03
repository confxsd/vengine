import { useState } from "react";
import {
  Dices,
  Download,
  ImageUp,
  Loader2,
  PencilRuler,
  Sparkles,
  Star,
  Trash2,
  X,
} from "lucide-react";
import {
  STUDY_CATEGORIES,
  STUDY_CATEGORY_VALUES,
  studyImageHash,
  type StudyCategory,
} from "@vengine/shared";
import type { CharacterStudy, StudyPatch } from "../types";
import { api } from "../api";
import { useStudio } from "../store";
import { Button, IconButton, Segmented, Select, Textarea } from "../components/ui";
import { SyncedInput, SyncedTextarea } from "../components/SyncedInput";
import { cn } from "@/lib/cn";
import { CATEGORY_ICONS } from "./studyCategories";

const MODE_OPTIONS = [
  { value: "tweak" as const, label: "Tweak" },
  { value: "restage" as const, label: "Re-stage" },
];

const MODE_HINT: Record<"tweak" | "restage", string> = {
  tweak: "Change only what you describe — keep composition, lighting & style.",
  restage: "Keep the look & identity, but allow a new pose, angle or layout.",
};

/**
 * The center workbench: one study under the loupe. Large preview (live while
 * generating), the variant filmstrip, curation controls (title / shelf / star /
 * notes) and the iterate loop — re-roll the brief, or refine the selected image
 * with an instruction (the comic's tweak/re-stage edit semantics).
 */
export function StudyWorkbench({
  study,
  busy,
  livePreview,
  refineSupported,
  onPatch,
  onDeleteVariant,
  onDelete,
  onReroll,
  onRefine,
  onPromote,
}: {
  study: CharacterStudy | undefined;
  busy: boolean;
  livePreview?: string;
  /** False when the selected model ignores references (refine would degrade). */
  refineSupported: boolean;
  onPatch: (patch: StudyPatch) => void;
  onDeleteVariant: (hash: string) => void;
  onDelete: () => void;
  onReroll: () => void;
  onRefine: (input: { baseHash: string; instruction: string; mode: "tweak" | "restage" }) => void;
  onPromote: (hash: string) => void;
}) {
  const openLightbox = useStudio((s) => s.openLightbox);
  const [refining, setRefining] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [mode, setMode] = useState<"tweak" | "restage">("tweak");

  if (!study) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
        <PencilRuler className="h-6 w-6 text-faint" />
        <p className="text-sm font-medium text-muted">No study on the bench</p>
        <p className="max-w-xs text-xs leading-relaxed text-faint">
          Compose a study on the left — a pose, an expression, a symbol from this character's
          world — or pick one from the system library on the right.
        </p>
      </div>
    );
  }

  const meta = STUDY_CATEGORIES[study.category];
  const current = studyImageHash(study);
  const shown = (busy && livePreview) || current;
  const canRefine = !!current && !busy && refineSupported;

  const applyRefine = () => {
    if (!canRefine || !instruction.trim() || !current) return;
    onRefine({ baseHash: current, instruction: instruction.trim(), mode });
    setInstruction("");
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Curation header */}
      <div className="flex items-center gap-2 border-b border-border px-4 py-2">
        <SyncedInput
          className="h-7 max-w-56 text-sm font-semibold"
          value={study.title}
          placeholder={`Untitled ${meta.label.toLowerCase()}`}
          onCommit={(title) => onPatch({ title })}
        />
        <Select
          className="h-7 w-32"
          value={study.category}
          onChange={(e) => onPatch({ category: e.target.value as StudyCategory })}
          title="Move to another shelf"
        >
          {STUDY_CATEGORY_VALUES.map((c) => (
            <option key={c} value={c}>
              {STUDY_CATEGORIES[c].label}
            </option>
          ))}
        </Select>
        <IconButton
          label={study.starred ? "Unset as canonical" : "Set as the canonical reference"}
          onClick={() => onPatch({ starred: !study.starred })}
          className={cn(study.starred && "text-amber")}
        >
          <Star className={cn("h-3.5 w-3.5", study.starred && "fill-current")} />
        </IconButton>
        <div className="flex-1" />
        <IconButton label="Delete this study" onClick={onDelete} className="text-down">
          <Trash2 className="h-3.5 w-3.5" />
        </IconButton>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
        {/* Preview */}
        <div
          className="relative mx-auto w-full max-w-md overflow-hidden rounded-lg ring-1 ring-inset ring-white/5"
          style={{ aspectRatio: `${meta.width} / ${meta.height}` }}
        >
          {shown ? (
            <button
              type="button"
              className="block h-full w-full"
              onClick={() => current && openLightbox(current)}
              title="Open full size"
            >
              <img src={api.thumbUrl(shown)} alt={study.title || meta.label} className="h-full w-full object-cover" />
            </button>
          ) : (
            <div className="flex h-full w-full items-center justify-center bg-elevated/40 text-[11px] text-faint">
              {busy ? "" : "no takes yet — generate below"}
            </div>
          )}
          {busy && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/45 text-[11px] font-medium text-white backdrop-blur-[1px]">
              <Loader2 className="h-5 w-5 animate-spin" />
              generating…
            </div>
          )}
        </div>

        {/* Filmstrip */}
        {study.variants.length > 0 && (
          <div className="mx-auto flex w-full max-w-md gap-1.5 overflow-x-auto pb-0.5">
            {study.variants.map((v) => (
              <div key={v.hash} className="group relative shrink-0">
                <button
                  type="button"
                  onClick={() => onPatch({ resultHash: v.hash })}
                  title={`Select · seed ${v.seed}`}
                  className={cn(
                    "block h-14 w-11 overflow-hidden rounded ring-1 transition",
                    v.hash === current ? "ring-2 ring-accent" : "ring-border hover:ring-border-strong",
                  )}
                >
                  <img src={api.thumbUrl(v.hash)} alt="take" className="h-full w-full object-cover" />
                </button>
                <button
                  type="button"
                  onClick={() => onDeleteVariant(v.hash)}
                  title="Delete this take"
                  className="absolute -right-1 -top-1 hidden h-4 w-4 items-center justify-center rounded-full bg-down text-white group-hover:flex"
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Actions */}
        <div className="mx-auto flex w-full max-w-md flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" disabled={busy || !study.prompt.trim()} onClick={onReroll} title="Generate fresh takes of this brief (new seeds)">
            <Dices className="h-3.5 w-3.5" />
            Re-roll
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!canRefine}
            onClick={() => setRefining((r) => !r)}
            title={refineSupported ? "Refine the selected take with an instruction" : "The selected model ignores references, so it can't refine in place"}
          >
            <PencilRuler className="h-3.5 w-3.5" />
            Refine
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={!current}
            onClick={() => current && onPromote(current)}
            title="Lead the character's identity references with this image"
          >
            <ImageUp className="h-3.5 w-3.5" />
            Promote to refs
          </Button>
          {current && (
            <a
              href={api.assetUrl(current)}
              download={`study-${study.id}-${current.slice(0, 8)}.png`}
              className="inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-muted hover:bg-elevated hover:text-text"
              title="Download the selected take"
            >
              <Download className="h-3.5 w-3.5" />
            </a>
          )}
        </div>

        {/* Refine panel */}
        {refining && (
          <div className="mx-auto flex w-full max-w-md flex-col gap-2 rounded-lg bg-elevated/40 p-3">
            <span className="eyebrow">Refine the selected take</span>
            <Textarea
              className="min-h-16"
              value={instruction}
              placeholder="e.g. turn the head toward the viewer; loosen the sleeve fabric"
              onChange={(e) => setInstruction(e.target.value)}
            />
            <div className="flex items-center gap-2">
              <Segmented size="sm" value={mode} onChange={setMode} options={MODE_OPTIONS} aria-label="Refine mode" />
              <span className="flex-1 text-[10px] leading-tight text-faint">{MODE_HINT[mode]}</span>
              <Button variant="accent" size="sm" disabled={!canRefine || !instruction.trim()} onClick={applyRefine}>
                <Sparkles className="h-3.5 w-3.5" />
                Apply
              </Button>
            </div>
          </div>
        )}

        {/* Brief + notes */}
        <div className="mx-auto flex w-full max-w-md flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="eyebrow">Brief</span>
            <SyncedTextarea
              className="min-h-14 text-xs"
              value={study.prompt}
              placeholder={meta.hint}
              onCommit={(prompt) => onPatch({ prompt })}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="eyebrow">Notes</span>
            <SyncedTextarea
              className="min-h-12 text-xs"
              value={study.notes}
              placeholder="Curator notes — “canonical from chapter 3”, “ears slightly long here”…"
              onCommit={(notes) => onPatch({ notes })}
            />
          </label>
        </div>
      </div>
    </div>
  );
}
