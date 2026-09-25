import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Calculator, Clapperboard, Layers, Play, Plus, Telescope, X, AlertTriangle } from "lucide-react";
import { cameraSizeOf, rhythmWarnings, SHOT_SIZE_LABELS, type ComicFrame } from "@vengine/shared";
import { useComic } from "../comicStore";
import { useLibrary } from "../libraryStore";
import { LibraryButton } from "../components/LibraryButton";
import { Button, Input, Segmented, Select, ThemeToggle } from "../components/ui";
import { ProjectHeader } from "./ProjectHeader";
import { FrameCard } from "./FrameCard";
import { DirectorPanel } from "./DirectorPanel";

const SAVE_LABEL: Record<string, string> = {
  idle: "",
  saving: "saving…",
  saved: "saved ✓",
  error: "save failed",
};

const QUALITY = [
  { value: "preview", label: "Preview" },
  { value: "final", label: "Final" },
] as const;

export function ComicStudio() {
  const {
    project,
    projects,
    init,
    loadProject,
    createProject,
    addFrame,
    quality,
    setQuality,
    doPlan,
    runAll,
    runSelected,
    selectedFrameIds,
    clearSelection,
    cancelRun,
    snapshot,
    running,
    plan,
    saveState,
    status,
    setName,
    directorAvailable,
  } = useComic();
  const [directorOpen, setDirectorOpen] = useState(false);
  const selectedCount = selectedFrameIds.length;

  useEffect(() => {
    void init();
  }, [init]);

  return (
    <div className="flex h-full flex-col">
      {/* Action bar */}
      <header className="flex items-center gap-3 border-b border-border bg-surface/80 px-4 py-2.5 backdrop-blur">
        <div className="flex items-center gap-2">
          <div className="h-5 w-5 rounded-md bg-gradient-to-br from-accent to-purple" />
          <span className="text-sm font-semibold tracking-tight text-text">
            vengine
          </span>
        </div>
        <LibraryButton />

        {directorAvailable && (
          <Button
            variant={directorOpen ? "accent" : "secondary"}
            size="sm"
            onClick={() => setDirectorOpen((v) => !v)}
            title="Discuss and revise the story with the director — edits apply automatically"
          >
            <Clapperboard className="h-3.5 w-3.5" />
            Director
          </Button>
        )}

        <div className="mx-1 h-5 w-px bg-border" />

        {/* Project switcher */}
        <Select
          className="max-w-44"
          value={project?.id ?? ""}
          onChange={(e) => void loadProject(e.target.value)}
        >
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} ({p.frameCount})
            </option>
          ))}
        </Select>
        <Button variant="secondary" size="sm" onClick={() => void createProject()}>
          <Plus className="h-3.5 w-3.5" />
          New
        </Button>

        {project && (
          <input
            className="w-44 rounded-md border border-transparent bg-transparent px-1.5 py-1 text-sm font-medium text-text outline-none transition-colors hover:border-border focus:border-accent"
            value={project.name}
            onChange={(e) => setName(e.target.value)}
          />
        )}
        <SeriesBadge seriesId={project?.seriesId} />

        <span className="font-mono text-[10px] text-faint">
          {SAVE_LABEL[saveState]}
        </span>

        <div className="flex-1" />

        <span className="max-w-56 truncate font-mono text-xs text-faint">
          {status}
        </span>

        <Segmented
          aria-label="Render quality"
          value={quality}
          onChange={setQuality}
          options={QUALITY}
          size="sm"
        />

        <Button variant="secondary" size="sm" onClick={doPlan}>
          <Calculator className="h-3.5 w-3.5" />
          Estimate
        </Button>
        {plan && (
          <span className="font-mono text-xs text-muted">
            ~${plan.estTotalCost.toFixed(4)}{" "}
            <span className="text-faint">
              ({plan.willRunCount} run · {plan.cachedCount} cached)
            </span>
          </span>
        )}

        <Button
          variant="secondary"
          size="sm"
          onClick={() => void snapshot()}
          title="Save a versioned snapshot"
        >
          <Layers className="h-3.5 w-3.5" />
          Snapshot
        </Button>

        <ThemeToggle />

        {running && (
          <Button
            variant="secondary"
            size="lg"
            className="text-down"
            onClick={() => void cancelRun()}
          >
            <X className="h-3.5 w-3.5" />
            Cancel
          </Button>
        )}
        {selectedCount > 0 && !running && (
          <>
            <Button
              variant="secondary"
              size="lg"
              onClick={clearSelection}
              title="Clear frame selection"
            >
              <X className="h-3.5 w-3.5" />
              Clear ({selectedCount})
            </Button>
            <Button
              variant="accent"
              size="lg"
              onClick={() => void runSelected()}
              title="Generate the selected frames"
            >
              <Play className="h-3.5 w-3.5 fill-current" />
              Generate selected ({selectedCount})
            </Button>
          </>
        )}
        <Button
          variant="accent"
          size="lg"
          onClick={() => void runAll()}
          disabled={running || !project?.frames.length}
        >
          <Play className="h-3.5 w-3.5 fill-current" />
          {running ? "Generating…" : "Generate all"}
        </Button>
      </header>

      {/* Body: settings sidebar + frame grid */}
      <div className="flex min-h-0 flex-1">
        <aside className="w-80 shrink-0 overflow-y-auto border-r border-border bg-surface">
          <ProjectHeader />
        </aside>
        <main className="min-w-0 flex-1 overflow-y-auto p-5">
          {project ? (
            <div className="flex flex-col">
              <RhythmRail frames={project.frames} />
              <div className="flex flex-wrap gap-4">
                {project.frames.map((f, i) => (
                  <FrameCard
                    key={f.id}
                    frame={f}
                    index={i}
                    total={project.frames.length}
                  />
                ))}
                <button
                  onClick={addFrame}
                  className="flex aspect-[9/16] w-56 shrink-0 flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-border text-sm text-faint transition-colors hover:border-accent/60 hover:text-muted"
                >
                  <Plus className="h-6 w-6" />
                  Add frame
                </button>
              </div>
            </div>
          ) : (
            <div className="text-sm text-faint">Loading…</div>
          )}
        </main>
        {directorOpen && project && <DirectorPanel onClose={() => setDirectorOpen(false)} />}
      </div>
    </div>
  );
}

/** Thin rail above the frame strip: the designed shot-size sequence (from the
 *  camera presets — free-text cameras don't participate) plus an advisory
 *  warning when `rhythmWarnings` has notes. Advisory only; never blocks a run. */
function RhythmRail({ frames }: { frames: ComicFrame[] }) {
  const notes = useMemo(() => rhythmWarnings({ frames }), [frames]);
  if (frames.length === 0) return null;
  return (
    <div
      className="mb-3 flex flex-wrap items-center gap-2 text-[11px] text-faint"
      title="Shot-size sequence (camera presets only) — the episode's designed rhythm"
    >
      <span className="text-[10px] font-medium uppercase tracking-wide">rhythm</span>
      <span className="flex flex-wrap items-center gap-1 font-mono">
        {frames.map((f, i) => {
          const size = cameraSizeOf(f);
          return (
            <span key={f.id} className="flex items-center gap-1">
              {i > 0 && <span className="text-faint/50">→</span>}
              <span
                className={size ? "text-muted" : ""}
                title={`Frame ${i + 1}${f.camera ? `: ${f.camera}` : " (no camera set)"}`}
              >
                {i + 1}·{size ? SHOT_SIZE_LABELS[size] : "–"}
              </span>
            </span>
          );
        })}
      </span>
      {notes.length > 0 && (
        <span
          className="flex cursor-help items-center gap-1 text-amber"
          title={notes.join("\n")}
        >
          <AlertTriangle className="h-3.5 w-3.5" />
          {notes.length}
        </span>
      )}
    </div>
  );
}

/** Small chip linking an episode to its universe (hidden when standalone). */
function SeriesBadge({ seriesId }: { seriesId?: string }) {
  const series = useLibrary((s) => s.library.series.find((x) => x.id === seriesId));
  if (!seriesId || !series) return null;
  return (
    <Link
      to={`/series/${series.id}`}
      title={`Episode of the universe “${series.name}”`}
      className="inline-flex max-w-44 items-center gap-1 rounded-full border border-border bg-elevated/50 px-2 py-0.5 text-[10px] text-muted transition-colors hover:border-accent/60 hover:text-accent"
    >
      <Telescope className="h-3 w-3 shrink-0" />
      <span className="truncate">{series.name || "Untitled universe"}</span>
    </Link>
  );
}
