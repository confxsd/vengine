import { useEffect, useRef, useState } from "react";
import { Check, ImageDown, Loader2, UploadCloud, X } from "lucide-react";
import { toast } from "sonner";
import { useLibrary } from "../libraryStore";
import { api } from "../api";
import { Button } from "../components/ui";
import type { LibraryCharacter, SheetSegmentResult } from "../types";

interface Props {
  character: LibraryCharacter;
  onClose: () => void;
}

type Phase = "pick" | "analyzing" | "review" | "saving";

/**
 * Import a combined character sheet as clean per-pose identity references. The sheet is
 * uploaded once, the server proposes crop regions (turnaround / expressions / poses,
 * each with a preview), and the user picks which to keep — text blocks and palette
 * swatches are proposed too but simply left unselected. Confirmed crops are banked and
 * appended to this character. Splitting the sheet matters: a model can't read identity
 * from one busy collage, but locks onto a few clean single-subject refs.
 */
export function SheetImportModal({ character, onClose }: Props) {
  const setModalOpen = useLibrary((s) => s.setModalOpen);
  const extractSheetRefs = useLibrary((s) => s.extractSheetRefs);

  const [phase, setPhase] = useState<Phase>("pick");
  const [hash, setHash] = useState<string>("");
  const [result, setResult] = useState<SheetSegmentResult | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const busy = phase === "analyzing" || phase === "saving";

  // Yield the panel's Esc handler to this modal (Esc closes the modal, not the panel).
  useEffect(() => {
    setModalOpen(true);
    return () => setModalOpen(false);
  }, [setModalOpen]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const analyze = async (file: File) => {
    setError(null);
    setPhase("analyzing");
    try {
      const { hash: sheetHash } = await api.uploadAsset(file);
      const segmented = await api.segmentSheet(sheetHash);
      if (segmented.regions.length === 0) {
        setError("No crop regions detected on this image. Try a clearer sheet on a plain background.");
        setPhase("pick");
        return;
      }
      setHash(sheetHash);
      setResult(segmented);
      // Pre-select the regions that look like character poses.
      setSelected(new Set(segmented.regions.flatMap((r, i) => (r.suggested ? [i] : []))));
      setPhase("review");
    } catch (err) {
      setError((err as Error).message);
      setPhase("pick");
    }
  };

  const toggle = (i: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  const setAll = (which: "all" | "none" | "suggested") => {
    if (!result) return;
    if (which === "none") setSelected(new Set());
    else if (which === "all") setSelected(new Set(result.regions.map((_, i) => i)));
    else setSelected(new Set(result.regions.flatMap((r, i) => (r.suggested ? [i] : []))));
  };

  const save = async () => {
    if (!result || selected.size === 0) return;
    setPhase("saving");
    try {
      const boxes = [...selected].sort((a, b) => a - b).map((i) => result.regions[i]!.box);
      const added = await extractSheetRefs(hash, character.id, boxes);
      toast.success(`Added ${added} reference${added === 1 ? "" : "s"} to ${character.name || "character"}`);
      onClose();
    } catch (err) {
      toast.error("Couldn't import references", { description: (err as Error).message });
      setPhase("review");
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
      onClick={() => !busy && onClose()}
    >
      <div
        className="flex max-h-[88vh] w-full max-w-3xl flex-col gap-4 rounded-xl border border-border bg-surface p-5 shadow-2xl shadow-black/40"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-text">
            <ImageDown className="h-4 w-4 text-accent" />
            Import sheet for {character.name || "this character"}
          </h2>
          <button onClick={() => !busy && onClose()} className="text-faint hover:text-text">
            <X className="h-4 w-4" />
          </button>
        </div>

        {(phase === "pick" || phase === "analyzing") && (
          <button
            onClick={() => !busy && fileRef.current?.click()}
            disabled={busy}
            className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border px-6 py-14 text-center text-muted transition hover:border-accent/60 hover:text-text disabled:opacity-70"
          >
            {phase === "analyzing" ? (
              <>
                <Loader2 className="h-7 w-7 animate-spin text-accent" />
                <span className="text-sm">Detecting poses…</span>
              </>
            ) : (
              <>
                <UploadCloud className="h-7 w-7" />
                <span className="text-sm font-medium">Choose a character sheet</span>
                <span className="max-w-md text-xs text-faint">
                  One image with a turnaround, expressions or pose studies. It's split into clean
                  single-pose references you can pick from — no manual cropping.
                </span>
              </>
            )}
          </button>
        )}

        {error && <p className="text-xs text-down">{error}</p>}

        {phase !== "pick" && phase !== "analyzing" && result && (
          <>
            <div className="flex items-center justify-between text-[11px] text-faint">
              <span>
                <span className="font-medium text-muted">{selected.size}</span> of {result.regions.length}{" "}
                selected · click a crop to toggle
              </span>
              <div className="flex gap-2">
                <button onClick={() => setAll("suggested")} className="hover:text-text">
                  Poses
                </button>
                <button onClick={() => setAll("all")} className="hover:text-text">
                  All
                </button>
                <button onClick={() => setAll("none")} className="hover:text-text">
                  None
                </button>
              </div>
            </div>

            <div className="grid max-h-[52vh] grid-cols-3 gap-2 overflow-y-auto pr-1 sm:grid-cols-4 md:grid-cols-5">
              {result.regions.map((r, i) => {
                const on = selected.has(i);
                return (
                  <button
                    key={i}
                    onClick={() => toggle(i)}
                    className={
                      "group relative aspect-[3/4] overflow-hidden rounded-md border bg-white/90 transition " +
                      (on ? "border-accent ring-2 ring-accent/60" : "border-border hover:border-muted")
                    }
                    title={r.suggested ? "Looks like a pose" : "Detected region"}
                  >
                    <img src={r.preview} alt="" className="h-full w-full object-contain" />
                    {on && (
                      <span className="absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-full bg-accent text-white">
                        <Check className="h-3 w-3" />
                      </span>
                    )}
                    {!on && (
                      <span className="absolute inset-0 bg-black/0 transition group-hover:bg-black/5" />
                    )}
                  </button>
                );
              })}
            </div>
          </>
        )}

        <div className="flex items-center justify-between border-t border-border pt-3">
          <span className="text-[11px] text-faint">
            {character.refHashes.length} existing reference{character.refHashes.length === 1 ? "" : "s"}
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="accent"
              size="sm"
              onClick={save}
              disabled={phase !== "review" || selected.size === 0}
            >
              {phase === "saving" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Check className="h-3.5 w-3.5" />
              )}
              Add {selected.size || ""} reference{selected.size === 1 ? "" : "s"}
            </Button>
          </div>
        </div>

        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void analyze(f);
            e.target.value = "";
          }}
        />
      </div>
    </div>
  );
}
