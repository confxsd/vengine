import { useEffect, useState } from "react";
import { Check, FileText, Loader2, Sparkles, Trash2, Wand2, X } from "lucide-react";
import { toast } from "sonner";
import type { DraftParse } from "@vengine/shared";
import { useComic } from "../comicStore";
import { api } from "../api";
import { Button, Field, Textarea } from "../components/ui";

interface Props {
  onClose: () => void;
}

type Phase = "input" | "parsing" | "review";

const SAMPLE = `frame1,
(we see the hero at a high-level meeting…)
inner voice: I spent my life for this…

frame2:
(on the rooftop at dusk, exhausted)
hero: it's over.`;

/**
 * Draft import. The author pastes a free-form story draft (frame markers,
 * (parenthetical) directions, dialogue / inner-voice); a text model splits it into
 * beats and turns each into a prompt-ready visual description, which the author
 * reviews and edits before it's written into the project as frames. Nothing is
 * applied until "Add to comic" — the parse is a proposal, not a commit.
 */
export function DraftModal({ onClose }: Props) {
  const applyDraft = useComic((s) => s.applyDraft);
  const hasFrames = useComic((s) => (s.project?.frames.length ?? 0) > 0);

  const [phase, setPhase] = useState<Phase>("input");
  const [text, setText] = useState("");
  const [parse, setParse] = useState<DraftParse | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Default: an empty project takes the draft wholesale (replace); a project with
  // frames appends, so an accidental import can't wipe existing work.
  const [replaceFrames, setReplaceFrames] = useState(!hasFrames);
  const [applyStory, setApplyStory] = useState(true);

  const busy = phase === "parsing";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const run = async () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setError(null);
    setPhase("parsing");
    try {
      const result = await api.parseDraft(trimmed);
      if (result.frames.length === 0) {
        setError("Couldn't split this into frames. Try marking beats (frame1, frame2…) or add more detail.");
        setPhase("input");
        return;
      }
      setParse(result);
      setPhase("review");
    } catch (err) {
      setError((err as Error).message);
      setPhase("input");
    }
  };

  // Patch the locally-held parse (edits stay client-side until applied).
  const patch = (p: Partial<DraftParse>) => setParse((prev) => (prev ? { ...prev, ...p } : prev));
  const patchFrame = (i: number, prompt: string) =>
    setParse((prev) =>
      prev ? { ...prev, frames: prev.frames.map((f, j) => (j === i ? { ...f, prompt } : f)) } : prev,
    );
  const removeFrame = (i: number) =>
    setParse((prev) => (prev ? { ...prev, frames: prev.frames.filter((_, j) => j !== i) } : prev));

  const apply = () => {
    if (!parse || parse.frames.length === 0) return;
    applyDraft(parse, { replaceFrames, applyStory });
    toast.success(
      `${replaceFrames ? "Imported" : "Added"} ${parse.frames.length} frame${
        parse.frames.length === 1 ? "" : "s"
      }`,
    );
    onClose();
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
            <FileText className="h-4 w-4 text-accent" />
            Import a draft
          </h2>
          <button onClick={() => !busy && onClose()} className="text-faint hover:text-text">
            <X className="h-4 w-4" />
          </button>
        </div>

        {phase !== "review" && (
          <>
            <p className="text-xs text-faint">
              Paste your story as you wrote it — frame markers, (scene directions), dialogue and
              inner-voice. It's split into frames, each with a ready visual prompt you can review.
            </p>
            <Textarea
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={SAMPLE}
              disabled={busy}
              className="min-h-64 resize-y font-mono text-xs leading-relaxed"
            />
            {error && <p className="text-xs text-down">{error}</p>}
          </>
        )}

        {phase === "review" && parse && (
          <div className="flex min-h-0 flex-col gap-4 overflow-y-auto pr-1">
            {/* Story / settings the parser inferred (editable, opt-in on apply). */}
            <div className="flex flex-col gap-3 rounded-lg border border-border bg-elevated/40 p-3">
              <label className="flex items-center gap-2 text-[11px] font-medium text-muted">
                <input
                  type="checkbox"
                  checked={applyStory}
                  onChange={(e) => setApplyStory(e.target.checked)}
                  className="accent-accent"
                />
                Also set the project's story &amp; settings
              </label>
              {applyStory && (
                <>
                  <Field label="Story">
                    <Textarea
                      value={parse.story}
                      onChange={(e) => patch({ story: e.target.value })}
                      className="min-h-16 text-xs"
                    />
                  </Field>
                  <Field label="Settings">
                    <Textarea
                      value={parse.settings}
                      onChange={(e) => patch({ settings: e.target.value })}
                      className="min-h-12 text-xs"
                    />
                  </Field>
                </>
              )}
            </div>

            <div className="text-[11px] text-faint">
              <span className="font-medium text-muted">{parse.frames.length}</span> frame
              {parse.frames.length === 1 ? "" : "s"} · edit a prompt or remove a beat before adding
            </div>

            <div className="flex flex-col gap-3">
              {parse.frames.map((f, i) => (
                <div key={i} className="flex gap-3 rounded-lg border border-border bg-surface p-3">
                  <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-elevated font-mono text-[11px] text-muted">
                    {i + 1}
                  </div>
                  <div className="flex min-w-0 flex-1 flex-col gap-2">
                    <Textarea
                      value={f.prompt}
                      onChange={(e) => patchFrame(i, e.target.value)}
                      placeholder="Visual description of this drawing…"
                      className="min-h-14 text-xs"
                    />
                    {f.script.trim() && (
                      <p className="whitespace-pre-wrap border-l-2 border-border pl-2 text-[11px] italic leading-snug text-faint">
                        {f.script.trim()}
                      </p>
                    )}
                    {f.characters.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {f.characters.map((c, j) => (
                          <span
                            key={j}
                            className="rounded-full bg-elevated px-1.5 py-0.5 text-[10px] text-muted"
                          >
                            {c}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  <button
                    onClick={() => removeFrame(i)}
                    title="Remove this beat"
                    className="h-6 text-faint transition-colors hover:text-down"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="flex items-center justify-between border-t border-border pt-3">
          <div className="flex items-center gap-3 text-[11px] text-faint">
            {phase === "review" && hasFrames && (
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={replaceFrames}
                  onChange={(e) => setReplaceFrames(e.target.checked)}
                  className="accent-accent"
                />
                Replace existing frames
              </label>
            )}
          </div>
          <div className="flex gap-2">
            {phase === "review" ? (
              <>
                <Button variant="ghost" size="sm" onClick={() => setPhase("input")}>
                  Back
                </Button>
                <Button variant="accent" size="sm" onClick={apply} disabled={!parse?.frames.length}>
                  <Check className="h-3.5 w-3.5" />
                  {replaceFrames ? "Import" : "Add"} {parse?.frames.length} frame
                  {parse?.frames.length === 1 ? "" : "s"}
                </Button>
              </>
            ) : (
              <>
                <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
                  Cancel
                </Button>
                <Button variant="accent" size="sm" onClick={run} disabled={busy || !text.trim()}>
                  {busy ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      Reading draft…
                    </>
                  ) : (
                    <>
                      <Wand2 className="h-3.5 w-3.5" />
                      Parse draft
                    </>
                  )}
                </Button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Trigger that opens the draft-import modal. Hidden when the text model is off. */
export function DraftImportButton() {
  const available = useComic((s) => s.draftAvailable);
  const [open, setOpen] = useState(false);
  if (!available) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-md border border-border bg-elevated/50 px-2 py-1 text-[11px] font-medium text-muted transition-colors hover:border-accent/60 hover:text-accent"
        title="Paste a free-form draft and split it into frames"
      >
        <Sparkles className="h-3 w-3" />
        Import draft
      </button>
      {open && <DraftModal onClose={() => setOpen(false)} />}
    </>
  );
}
