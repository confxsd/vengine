import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { BookOpen, Plus } from "lucide-react";
import { useLibrary } from "../libraryStore";
import { api } from "../api";
import { Button, Input } from "../components/ui";
import type { ProjectSummary } from "../types";
import { PageShell } from "./PageShell";

/**
 * Universes — shared visual worlds. Each universe owns a look (style pack with
 * reference images + style prompts) and a cast (characters with identity references
 * + aliases); every episode pasted into it inherits all of it. This index shows the
 * universes at a glance; the detail page is where the world is edited.
 */
export default function SeriesPage() {
  const navigate = useNavigate();
  const series = useLibrary((s) => s.library.series);
  const styles = useLibrary((s) => s.library.styles);
  const characters = useLibrary((s) => s.library.characters);
  const createSeries = useLibrary((s) => s.createSeries);
  const [name, setName] = useState("");
  const [projects, setProjects] = useState<ProjectSummary[]>([]);

  useEffect(() => {
    api.comics().then(setProjects).catch(() => setProjects([]));
  }, []);

  const add = async () => {
    if (!name.trim()) return;
    const created = await createSeries(name);
    setName("");
    if (created) navigate(`/series/${created.id}`);
  };

  return (
    <PageShell
      title="Universes"
      subtitle="Shared visual worlds — one look and cast, reused by every story you paste into them"
      icon={<BookOpen className="h-4 w-4" />}
    >
      <div className="flex flex-col gap-4">
        <div className="flex gap-2">
          <Input
            value={name}
            placeholder="New universe (e.g. The Batman — animated noir)"
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
            No universes yet. Create one, give it style reference images and a recurring cast —
            then paste any story that belongs to it and everything is applied automatically.
          </p>
        )}

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {series.map((s) => {
            const pack = s.defaultStyleId ? styles.find((st) => st.id === s.defaultStyleId) : undefined;
            const cast = characters.filter((c) => s.castIds.includes(c.id));
            const episodes = projects.filter((p) => s.projectIds.includes(p.id));
            return (
              <button
                key={s.id}
                onClick={() => navigate(`/series/${s.id}`)}
                className="flex flex-col gap-3 rounded-lg border border-border bg-bg/40 p-4 text-left transition hover:border-accent/60"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-sm font-semibold text-text">
                    {s.name || "Untitled universe"}
                  </span>
                  <span className="shrink-0 text-[10px] uppercase tracking-wide text-faint">
                    {episodes.length} episode{episodes.length === 1 ? "" : "s"}
                  </span>
                </div>

                {/* The look at a glance: style anchors, falling back to cast refs. */}
                <div className="flex h-14 items-center gap-1.5">
                  {(pack?.anchors.length ? pack.anchors.map((a) => a.hash) : cast.flatMap((c) => c.refHashes))
                    .slice(0, 7)
                    .map((h, i) => (
                      <img
                        key={`${h}-${i}`}
                        src={api.thumbUrl(h)}
                        alt=""
                        className="h-14 w-14 rounded-md border border-border object-cover"
                      />
                    ))}
                  {pack && pack.anchors.length === 0 && cast.length === 0 && (
                    <span className="text-[11px] text-faint">No references yet — open to add the look</span>
                  )}
                </div>

                {s.concept && <p className="line-clamp-2 text-[11px] leading-snug text-faint">{s.concept}</p>}

                <div className="flex flex-wrap items-center gap-1.5">
                  {cast.slice(0, 6).map((c) => (
                    <span
                      key={c.id}
                      className="flex items-center gap-1 rounded-full bg-elevated px-1.5 py-0.5 text-[10px] text-muted"
                    >
                      {c.refHashes[0] && (
                        <img src={api.thumbUrl(c.refHashes[0])} alt="" className="h-4 w-4 rounded-full object-cover" />
                      )}
                      {c.name}
                    </span>
                  ))}
                  {s.keywords.slice(0, 4).map((k) => (
                    <span key={k} className="rounded-full border border-border px-1.5 py-0.5 text-[10px] text-faint">
                      {k}
                    </span>
                  ))}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </PageShell>
  );
}
