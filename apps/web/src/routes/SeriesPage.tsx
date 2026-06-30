import { useEffect, useState } from "react";
import { BookOpen, Plus, Trash2 } from "lucide-react";
import { useLibrary } from "../libraryStore";
import { api } from "../api";
import { Button, Input, Select } from "../components/ui";
import { SyncedInput, SyncedTextarea } from "../components/SyncedInput";
import { cn } from "@/lib/cn";
import type { ProjectSummary, Series } from "../types";
import { PageShell } from "./PageShell";

/**
 * Series — long-form groupings of projects that share a recurring cast and a default
 * style. A series references projects, characters and a style by id (no copies), so
 * it's the continuity layer over the storyboard: define the cast once, reuse it
 * chapter after chapter.
 */
export default function SeriesPage() {
  const series = useLibrary((s) => s.library.series);
  const createSeries = useLibrary((s) => s.createSeries);
  const [name, setName] = useState("");
  const [projects, setProjects] = useState<ProjectSummary[]>([]);

  useEffect(() => {
    api.comics().then(setProjects).catch(() => setProjects([]));
  }, []);

  const add = async () => {
    if (!name.trim()) return;
    await createSeries(name);
    setName("");
  };

  return (
    <PageShell
      title="Series"
      subtitle="Group projects into a continuing series with a shared cast & style"
      icon={<BookOpen className="h-4 w-4" />}
    >
      <div className="flex flex-col gap-4">
        <div className="flex gap-2">
          <Input
            value={name}
            placeholder="New series (e.g. Yue — Tales of the Exiled Moon)"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void add()}
          />
          <Button variant="secondary" size="sm" onClick={() => void add()}>
            <Plus className="h-3.5 w-3.5" />
            Add
          </Button>
        </div>

        {series.length === 0 && (
          <p className="px-1 py-10 text-center text-xs text-faint">
            No series yet. Create one to bundle a recurring cast and a default style across many
            chapters.
          </p>
        )}

        {series.map((s) => (
          <SeriesCard key={s.id} series={s} projects={projects} />
        ))}
      </div>
    </PageShell>
  );
}

function SeriesCard({ series, projects }: { series: Series; projects: ProjectSummary[] }) {
  const characters = useLibrary((s) => s.library.characters);
  const styles = useLibrary((s) => s.library.styles);
  const patch = useLibrary((s) => s.patchSeriesPack);
  const remove = useLibrary((s) => s.deleteSeries);

  const toggle = (key: "projectIds" | "castIds", id: string) => {
    const cur = series[key];
    const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
    void patch(series.id, { [key]: next });
  };

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-bg/40 p-4">
      <div className="flex items-center gap-2">
        <SyncedInput
          className="h-8 flex-1 text-sm font-semibold"
          value={series.name}
          onCommit={(v) => void patch(series.id, { name: v })}
        />
        <button title="Delete series" onClick={() => void remove(series.id)} className="text-faint hover:text-down">
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      <SyncedTextarea
        className="h-14 text-xs"
        value={series.description}
        placeholder="What ties these chapters together — premise, arc, tone"
        onCommit={(v) => void patch(series.id, { description: v })}
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <span className="text-[10px] uppercase tracking-wide text-faint">Default style</span>
          <Select
            value={series.defaultStyleId ?? ""}
            onChange={(e) => void patch(series.id, { defaultStyleId: e.target.value || undefined })}
          >
            <option value="">— none —</option>
            {styles.map((st) => (
              <option key={st.id} value={st.id}>
                {st.name}
              </option>
            ))}
          </Select>
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-[10px] uppercase tracking-wide text-faint">Cast</span>
          <div className="flex flex-wrap gap-1.5">
            {characters.length === 0 && <span className="text-[11px] text-faint">No characters yet.</span>}
            {characters.map((c) => (
              <Chip key={c.id} on={series.castIds.includes(c.id)} onClick={() => toggle("castIds", c.id)}>
                {c.name || "Unnamed"}
              </Chip>
            ))}
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-[10px] uppercase tracking-wide text-faint">
          Projects · {series.projectIds.length}
        </span>
        <div className="flex flex-wrap gap-1.5">
          {projects.length === 0 && <span className="text-[11px] text-faint">No comics yet.</span>}
          {projects.map((p) => (
            <Chip key={p.id} on={series.projectIds.includes(p.id)} onClick={() => toggle("projectIds", p.id)}>
              {p.name || "Untitled"}
            </Chip>
          ))}
        </div>
      </div>
    </div>
  );
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "rounded-full border px-2.5 py-1 text-[11px] transition",
        on ? "border-accent bg-accent/15 text-accent" : "border-border text-muted hover:border-muted",
      )}
    >
      {children}
    </button>
  );
}
