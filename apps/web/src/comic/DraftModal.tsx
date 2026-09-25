import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, Clapperboard, FileText, Loader2, Sparkles, Trash2, Wand2, X } from "lucide-react";
import { toast } from "sonner";
import {
  EPISODE_STRUCTURE_LABELS,
  rhythmWarnings,
  type ComicFrame,
  type DraftParse,
  type DraftSeriesRef,
} from "@vengine/shared";
import { useComic } from "../comicStore";
import { useLibrary } from "../libraryStore";
import { api } from "../api";
import { Button, Field, Textarea } from "../components/ui";
import { cn } from "@/lib/cn";

interface Props {
  onClose: () => void;
  /** Pre-select a universe (the "New episode" entry point on a universe page). */
  initialSeriesId?: string;
}

type Phase = "input" | "parsing" | "review";

const SAMPLE = `frame1,
(we see the hero at a high-level meeting…)
inner voice: I spent my life for this…

frame2:
(on the rooftop at dusk, exhausted)
hero: it's over.`;

/**
 * The story composer. The author pastes a free-form story (frame markers,
 * (parenthetical) directions, dialogue / inner-voice); a text model splits it into
 * beats and turns each into a prompt-ready visual description. When the story is
 * recognized as part of a **universe** (series), the whole shared visual identity —
 * style pack, cast with identity references, premise — is shown up front and wired
 * into a NEW episode on apply, optionally generating every frame immediately.
 * The old path (append the beats to the current comic) stays as a secondary action.
 */
export function DraftModal({ onClose, initialSeriesId }: Props) {
  const applyDraft = useComic((s) => s.applyDraft);
  const importStory = useComic((s) => s.importStory);
  const hasFrames = useComic((s) => (s.project?.frames.length ?? 0) > 0);
  const seriesList = useLibrary((s) => s.library.series);
  const styles = useLibrary((s) => s.library.styles);
  const characters = useLibrary((s) => s.library.characters);

  const [phase, setPhase] = useState<Phase>("input");
  const [text, setText] = useState("");
  const [parse, setParse] = useState<DraftParse | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The universe the parse ran with (explicit pick or auto-detection) + the one the
  // author has currently chosen for apply (they can override without re-parsing;
  // character mapping is alias-aware client-side, so a swap still lands the cast).
  const [detected, setDetected] = useState<DraftSeriesRef | null>(null);
  const [seriesId, setSeriesId] = useState<string | undefined>(initialSeriesId);
  const [explicit, setExplicit] = useState<boolean>(!!initialSeriesId);
  const [generate, setGenerate] = useState(true);
  const [creating, setCreating] = useState(false);
  // Default: an empty project takes the draft wholesale (replace); a project with
  // frames appends, so an accidental import can't wipe existing work.
  const [replaceFrames, setReplaceFrames] = useState(!hasFrames);
  const [applyStory, setApplyStory] = useState(true);

  const busy = phase === "parsing" || creating;

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
      const result = await api.parseDraft(trimmed, explicit ? seriesId : undefined);
      if (result.frames.length === 0) {
        setError("Couldn't split this into frames. Try marking beats (frame1, frame2…) or add more detail.");
        setPhase("input");
        return;
      }
      const { series, ...rest } = result;
      setParse(rest);
      setDetected(series);
      // The parse's universe becomes the apply default (auto-detected or explicit);
      // the author can still override it in the review footer.
      if (!seriesId && series) setSeriesId(series.id);
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
    setParse((prev) =>
      prev
        ? {
            ...prev,
            frames: prev.frames
              .filter((_, j) => j !== i)
              // Link indices (continues/echo) refer to the parse's own order: a
              // link AT the removed beat is dropped, links past it shift down one.
              .map((f) => {
                let next = f;
                for (const key of ["continues", "echo"] as const) {
                  const at = next[key];
                  if (at === undefined) continue;
                  if (at === i) {
                    const { [key]: _dropped, ...rest } = next;
                    next = rest as typeof f;
                  } else if (at > i) {
                    next = { ...next, [key]: at - 1 };
                  }
                }
                return next;
              }),
          }
        : prev,
    );

  const activeSeries = useMemo(
    () => seriesList.find((s) => s.id === seriesId),
    [seriesList, seriesId],
  );
  const activePack = useMemo(
    () => (activeSeries?.defaultStyleId ? styles.find((st) => st.id === activeSeries.defaultStyleId) : undefined),
    [activeSeries, styles],
  );
  const activeCast = useMemo(
    () => (activeSeries ? characters.filter((c) => activeSeries.castIds.includes(c.id)) : []),
    [activeSeries, characters],
  );
  // Which universe characters this story actually uses (by canonical name or alias) —
  // the avatars that will steer identity in the generated frames.
  const storyCharacterNames = useMemo(
    () => new Set((parse?.frames ?? []).flatMap((f) => f.characters).map((n) => n.trim().toLowerCase())),
    [parse],
  );
  const castInStory = useMemo(
    () =>
      activeCast.filter((c) =>
        [c.name, ...c.aliases].some((n) => n.trim().toLowerCase() && storyCharacterNames.has(n.trim().toLowerCase())),
      ),
    [activeCast, storyCharacterNames],
  );
  // Advisory review notes (rhythm + gutter budget) computed on the not-yet-applied
  // parse — same pure `rhythmWarnings` the Studio rail uses, fed id-less stand-in
  // frames carrying exactly the fields the checker reads (gutter, and the
  // continuity/echo links under the same strictly-earlier validation the apply
  // path applies). Notes advise; the apply goes through regardless (the author
  // decides). Camera sizes don't exist until the beats land on frames, so the
  // shot-size checks only start firing in the Studio rail.
  const reviewNotes = useMemo(() => {
    if (!parse) return [];
    const frames = parse.frames.map<ComicFrame>((f, i) => ({
      id: String(i),
      prompt: f.prompt,
      variants: [],
      refHashes: [],
      ...(i > 0 && f.gutter ? { gutter: f.gutter } : {}),
      ...(f.continues !== undefined && f.continues < i
        ? { continuesFrameId: String(f.continues) }
        : {}),
      ...(f.echo !== undefined && f.echo < i ? { echoFrameId: String(f.echo) } : {}),
    }));
    return rhythmWarnings({ frames });
  }, [parse]);

  const createEpisode = async () => {
    if (!parse || parse.frames.length === 0) return;
    setCreating(true);
    try {
      await importStory(parse, { seriesId: activeSeries?.id, generate });
    } finally {
      setCreating(false);
    }
    onClose();
  };

  const apply = () => {
    if (!parse || parse.frames.length === 0) return;
    applyDraft(parse, { replaceFrames, applyStory });
    toast.success(
      `${replaceFrames ? "Imported" : "Added"} ${parse.frames.length} frame${parse.frames.length === 1 ? "" : "s"}`,
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
            <Clapperboard className="h-4 w-4 text-accent" />
            New story
          </h2>
          <button onClick={() => !busy && onClose()} className="text-faint hover:text-text">
            <X className="h-4 w-4" />
          </button>
        </div>

        {phase !== "review" && (
          <>
            <p className="text-xs text-faint">
              Paste your story as you wrote it — frame markers, (scene directions), dialogue and
              inner-voice. It's split into frames, wired into the right universe, and generated.
            </p>
            <Textarea
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={SAMPLE}
              disabled={busy}
              className="min-h-64 resize-y font-mono text-xs leading-relaxed"
            />
            {seriesList.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 text-[11px] text-faint">
                <span>Universe:</span>
                <select
                  value={explicit ? (seriesId ?? "") : ""}
                  disabled={busy}
                  onChange={(e) => {
                    const v = e.target.value;
                    setExplicit(v !== "");
                    setSeriesId(v || undefined);
                  }}
                  className="rounded-md border border-border bg-elevated/50 px-2 py-1 text-[11px] text-muted"
                >
                  <option value="">Auto-detect from the story</option>
                  {seriesList.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name || "Untitled universe"}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {error && <p className="text-xs text-down">{error}</p>}
          </>
        )}

        {phase === "review" && parse && (
          <div className="flex min-h-0 flex-col gap-4 overflow-y-auto pr-1">
            {/* The universe this story resolved to — the shared visual identity that
                will be wired into the episode (style anchors + cast identity refs). */}
            {(detected || seriesList.length > 0) && (
              <div className="flex flex-col gap-3 rounded-lg border border-border bg-elevated/40 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="text-[10px] uppercase tracking-wide text-faint">Universe</span>
                    <select
                      value={seriesId ?? ""}
                      onChange={(e) => setSeriesId(e.target.value || undefined)}
                      className="max-w-56 rounded-md border border-border bg-surface px-2 py-1 text-[11px] text-text"
                    >
                      <option value="">None — standalone story</option>
                      {seriesList.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name || "Untitled universe"}
                        </option>
                      ))}
                    </select>
                    {detected && detected.id === seriesId && detected.matchedBy.length > 0 && (
                      <span className="truncate text-[10px] italic text-faint" title={detected.matchedBy.join(", ")}>
                        matched “{detected.matchedBy.slice(0, 4).join(", ")}
                        {detected.matchedBy.length > 4 ? "…" : ""}”
                      </span>
                    )}
                  </div>
                </div>
                {activeSeries && (
                  <div className="flex flex-col gap-2">
                    {activePack && activePack.anchors.length > 0 && (
                      <div className="flex items-center gap-2">
                        <span className="shrink-0 text-[10px] uppercase tracking-wide text-faint">Look</span>
                        <div className="flex flex-wrap gap-1.5">
                          {activePack.anchors.map((a) => (
                            <img
                              key={a.hash}
                              src={api.thumbUrl(a.hash)}
                              alt={a.label ?? "style anchor"}
                              title={a.label ?? "style anchor"}
                              className="h-10 w-10 rounded-md border border-border object-cover"
                            />
                          ))}
                        </div>
                      </div>
                    )}
                    {activeCast.length > 0 && (
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="shrink-0 text-[10px] uppercase tracking-wide text-faint">Cast</span>
                        {activeCast.map((c) => {
                          const inStory = castInStory.some((d) => d.id === c.id);
                          return (
                            <span
                              key={c.id}
                              title={inStory ? `In this story${c.aliases.length ? ` (${c.aliases.join(", ")})` : ""}` : "Not in this story"}
                              className={cn(
                                "flex items-center gap-1.5 rounded-full border py-0.5 pl-0.5 pr-2 text-[11px]",
                                inStory
                                  ? "border-accent/60 bg-accent/10 text-accent"
                                  : "border-border text-muted",
                              )}
                            >
                              {c.refHashes[0] ? (
                                <img
                                  src={api.thumbUrl(c.refHashes[0])}
                                  alt=""
                                  className="h-5 w-5 rounded-full border border-border object-cover"
                                />
                              ) : (
                                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-elevated text-[9px]">
                                  {c.name.slice(0, 1)}
                                </span>
                              )}
                              {c.name}
                            </span>
                          );
                        })}
                      </div>
                    )}
                    {castInStory.length === 0 && activeCast.length > 0 && (
                      <p className="text-[10px] text-faint">
                        None of this universe's cast was detected — frames will still use its style.
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* The episode's creative plan — the one vision every frame prompt
                receives. Shown as read-only; refine it later via the director. */}
            {parse.plan && (
              <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-elevated/40 p-3">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] uppercase tracking-wide text-faint">Plan</span>
                  <span className="rounded-full bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium text-accent">
                    {EPISODE_STRUCTURE_LABELS[parse.plan.structure]}
                  </span>
                </div>
                <div className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-[11px]">
                  {(
                    [
                      ["art direction", parse.plan.archetype],
                      ["strategy", parse.plan.strategy],
                      ["theme", parse.plan.theme],
                      ["motif", parse.plan.motif],
                      ["next episode", parse.plan.token],
                    ] as const
                  )
                    .filter(([, v]) => v.trim())
                    .map(([label, v]) => (
                      <div key={label} className="col-span-2 flex gap-2">
                        <span className="w-24 shrink-0 text-faint">{label}</span>
                        <span className="min-w-0 text-muted">{v.trim()}</span>
                      </div>
                    ))}
                </div>
              </div>
            )}

            {/* Advisory review notes (rhythm + gutter budget) — the author sees
                them before generating; applying proceeds regardless. */}
            {reviewNotes.length > 0 && (
              <div className="flex flex-col gap-1 rounded-lg border border-amber/30 bg-amber/10 p-3">
                <div className="flex items-center gap-1.5 text-[11px] font-medium text-amber">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  Review notes
                </div>
                <ul className="flex flex-col gap-0.5">
                  {reviewNotes.map((n, i) => (
                    <li key={i} className="text-[11px] leading-snug text-amber/90">
                      · {n}
                    </li>
                  ))}
                </ul>
              </div>
            )}

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
                    {/* Structure + storyline treatment the parser inferred: the
                        beat's role, its typed gutter in, thread grouping, per-beat
                        tone, palette accents, and continuity/echo links (incl.
                        non-adjacent beats of an interleaved storyline). */}
                    {(f.role ||
                      f.gutter ||
                      f.thread.trim() ||
                      f.mood.trim() ||
                      f.palette.length > 0 ||
                      f.continues !== undefined ||
                      f.echo !== undefined) && (
                      <div className="flex flex-wrap items-center gap-1">
                        {f.role && (
                          <span
                            className="rounded-full bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium text-accent"
                            title="This beat's role in the episode structure — flavors the craft directive"
                          >
                            ◆ {f.role}
                          </span>
                        )}
                        {f.gutter && (
                          <span
                            className="rounded-full bg-elevated px-1.5 py-0.5 text-[10px] text-muted"
                            title="The typed transition into this beat (McCloud's six) — composes a Transition directive"
                          >
                            ↳ {f.gutter}
                          </span>
                        )}
                        {f.thread.trim() && (
                          <span
                            className="rounded-full bg-purple/15 px-1.5 py-0.5 text-[10px] text-purple"
                            title="Storyline this beat belongs to — threads get their own look"
                          >
                            ⭆ {f.thread.trim()}
                          </span>
                        )}
                        {f.mood.trim() && (
                          <span className="rounded-full bg-elevated px-1.5 py-0.5 text-[10px] text-muted" title="This beat's tone">
                            {f.mood.trim()}
                          </span>
                        )}
                        {f.palette.length > 0 && (
                          <span className="flex items-center gap-1 rounded-full bg-elevated px-1.5 py-0.5 text-[10px] text-muted" title="This storyline's palette accents">
                            {f.palette.slice(0, 5).map((c, j) => {
                              const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c.trim());
                              return hex ? (
                                <span key={j} className="h-2.5 w-2.5 rounded-full ring-1 ring-white/20" style={{ background: c.trim() }} />
                              ) : (
                                <span key={j}>{c.trim()}</span>
                              );
                            })}
                          </span>
                        )}
                        {f.continues !== undefined && (
                          <span className="rounded-full bg-elevated px-1.5 py-0.5 text-[10px] text-faint" title="Continues that beat's scene (its image feeds this frame as the continuity reference)">
                            ↪ frame {f.continues + 1}
                          </span>
                        )}
                        {f.echo !== undefined && (
                          <span className="rounded-full bg-elevated px-1.5 py-0.5 text-[10px] text-faint" title="Mirrors that beat's composition — the bookend payout (its image leads the references)">
                            ⧉ echoes frame {f.echo + 1}
                          </span>
                        )}
                      </div>
                    )}
                    {f.characters.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {f.characters.map((c, j) => (
                          <span
                            key={j}
                            className={cn(
                              "rounded-full px-1.5 py-0.5 text-[10px]",
                              activeCast.some((a) =>
                                [a.name, ...a.aliases].some(
                                  (n) => n.trim().toLowerCase() === c.trim().toLowerCase(),
                                ),
                              )
                                ? "bg-accent/15 text-accent"
                                : "bg-elevated text-muted",
                            )}
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

        <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
          <div className="flex items-center gap-3 text-[11px] text-faint">
            {phase === "review" && (
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={generate}
                  onChange={(e) => setGenerate(e.target.checked)}
                  className="accent-accent"
                />
                Generate immediately
              </label>
            )}
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
                <Button variant="ghost" size="sm" onClick={apply} disabled={!parse?.frames.length}>
                  <FileText className="h-3.5 w-3.5" />
                  Add to current comic
                </Button>
                <Button
                  variant="accent"
                  size="sm"
                  onClick={() => void createEpisode()}
                  disabled={!parse?.frames.length || creating}
                >
                  {creating ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      Creating…
                    </>
                  ) : (
                    <>
                      <Sparkles className="h-3.5 w-3.5" />
                      Create {activeSeries ? "episode" : "project"} · {parse?.frames.length} frame
                      {parse?.frames.length === 1 ? "" : "s"}
                      {generate ? " →" : ""}
                    </>
                  )}
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
                      Reading story…
                    </>
                  ) : (
                    <>
                      <Wand2 className="h-3.5 w-3.5" />
                      Read story
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

/** Trigger that opens the story composer. Hidden when the text model is off. */
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
        title="Paste a story — it's split into frames, wired into its universe, and generated"
      >
        <Sparkles className="h-3 w-3" />
        Paste story
      </button>
      {open && <DraftModal onClose={() => setOpen(false)} />}
    </>
  );
}
