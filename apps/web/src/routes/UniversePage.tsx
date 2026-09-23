import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, BookOpen, Clapperboard, ImagePlus, Plus, Trash2, X } from "lucide-react";
import { DEFAULT_NEGATIVE } from "@vengine/shared";
import { useLibrary } from "../libraryStore";
import { useComic } from "../comicStore";
import { api } from "../api";
import { Button, Input, Select } from "../components/ui";
import { SyncedInput, SyncedTextarea } from "../components/SyncedInput";
import { cn } from "@/lib/cn";
import type { ComicReference, ModelInfo, ProjectSummary } from "../types";
import { PageShell } from "./PageShell";
import { DraftModal } from "../comic/DraftModal";

/**
 * A universe's home: everything shared across its episodes, edited in one place.
 * The **look** (style pack: reference images + style prompts + model) and the
 * **cast** (recurring characters with identity references + aliases) live on the
 * library, referenced by id — so an edit here flows into every future episode,
 * and pasting a story that mentions these characters auto-detects the universe.
 */
export default function UniversePage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const seriesList = useLibrary((s) => s.library.series);
  const characters = useLibrary((s) => s.library.characters);
  const styles = useLibrary((s) => s.library.styles);
  const patchSeries = useLibrary((s) => s.patchSeriesPack);
  const deleteSeries = useLibrary((s) => s.deleteSeries);
  const patchStylePack = useLibrary((s) => s.patchStylePack);
  const createStyle = useLibrary((s) => s.createStyle);
  const createCharacter = useLibrary((s) => s.createCharacter);
  const addCharacterRef = useLibrary((s) => s.addCharacterRef);

  const series = seriesList.find((s) => s.id === id);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [newEpisode, setNewEpisode] = useState(false);
  const [newKeyword, setNewKeyword] = useState("");

  useEffect(() => {
    api.comics().then(setProjects).catch(() => setProjects([]));
    api.models().then(setModels).catch(() => setModels([]));
  }, []);

  const pack = series?.defaultStyleId ? styles.find((st) => st.id === series.defaultStyleId) : undefined;
  const cast = useMemo(
    () => (series ? characters.filter((c) => series.castIds.includes(c.id)) : []),
    [series, characters],
  );
  const episodes = useMemo(
    () => (series ? projects.filter((p) => series.projectIds.includes(p.id)) : []),
    [series, projects],
  );

  if (!series) {
    return (
      <PageShell title="Universe not found" icon={<BookOpen className="h-4 w-4" />}>
        <Button variant="ghost" size="sm" onClick={() => navigate("/series")}>
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to universes
        </Button>
      </PageShell>
    );
  }

  const addKeyword = () => {
    const k = newKeyword.trim().toLowerCase();
    if (!k || series.keywords.includes(k)) return;
    void patchSeries(series.id, { keywords: [...series.keywords, k] });
    setNewKeyword("");
  };

  return (
    <PageShell
      title={series.name || "Untitled universe"}
      subtitle={series.concept ? series.concept.slice(0, 120) : "A shared visual universe — style, cast and premise reused by every episode"}
      icon={<BookOpen className="h-4 w-4" />}
      actions={
        <div className="flex items-center gap-2">
          <Button variant="accent" size="sm" onClick={() => setNewEpisode(true)}>
            <Clapperboard className="h-3.5 w-3.5" />
            New episode
          </Button>
          <button
            title="Delete universe (projects are untouched)"
            onClick={() => {
              if (confirm(`Delete the universe “${series.name || "Untitled"}”? Its episodes are kept.`)) {
                void deleteSeries(series.id).then(() => navigate("/series"));
              }
            }}
            className="text-faint hover:text-down"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      }
    >
      <div className="flex flex-col gap-6">
        {/* ── Identity: premise + recognition keywords ─────────────────────────── */}
        <section className="flex flex-col gap-3 rounded-lg border border-border bg-bg/40 p-4">
          <h2 className="eyebrow">Identity</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto] sm:items-start">
            <div className="flex flex-col gap-1.5">
              <span className="text-[10px] uppercase tracking-wide text-faint">Name</span>
              <SyncedInput
                className="h-8 text-sm font-semibold"
                value={series.name}
                onCommit={(v) => void patchSeries(series.id, { name: v })}
              />
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-[10px] uppercase tracking-wide text-faint">
              Premise — fed to the story parser so every episode stays in canon
            </span>
            <SyncedTextarea
              className="min-h-20 text-xs"
              value={series.concept}
              placeholder="The world, tone and recurring situation of this universe…"
              onCommit={(v) => void patchSeries(series.id, { concept: v })}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-[10px] uppercase tracking-wide text-faint">
              Keywords — a pasted story mentioning these auto-joins this universe
            </span>
            <div className="flex flex-wrap items-center gap-1.5">
              {series.keywords.map((k) => (
                <TagChip
                  key={k}
                  label={k}
                  onRemove={() =>
                    void patchSeries(series.id, { keywords: series.keywords.filter((x) => x !== k) })
                  }
                />
              ))}
              <input
                value={newKeyword}
                onChange={(e) => setNewKeyword(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addKeyword()}
                onBlur={addKeyword}
                placeholder="add keyword ⏎"
                className="w-28 rounded-full border border-dashed border-border bg-transparent px-2 py-1 text-[11px] text-muted outline-none focus:border-accent/60"
              />
            </div>
          </div>
        </section>

        {/* ── Look: the shared style pack ──────────────────────────────────────── */}
        <section className="flex flex-col gap-3 rounded-lg border border-border bg-bg/40 p-4">
          <div className="flex items-center justify-between">
            <h2 className="eyebrow">Look — shared style</h2>
            {styles.length > 0 && (
              <Select
                value={series.defaultStyleId ?? ""}
                onChange={(e) => void patchSeries(series.id, { defaultStyleId: e.target.value || undefined })}
                className="h-7 max-w-56 text-[11px]"
              >
                <option value="">— pick a style pack —</option>
                {styles.map((st) => (
                  <option key={st.id} value={st.id}>
                    {st.name}
                  </option>
                ))}
              </Select>
            )}
          </div>

          {!pack ? (
            <div className="flex items-center justify-between gap-3 rounded-md border border-dashed border-border p-3 text-xs text-faint">
              No style pack linked — episodes won't share a look.
              <Button
                variant="secondary"
                size="sm"
                onClick={() =>
                  void createStyle(`${series.name || "Untitled"} — look`).then(() => {
                    // Link the newest pack once it lands (createStyle appends it).
                    setTimeout(() => {
                      const created = useLibrary.getState().library.styles.at(-1);
                      if (created) void patchSeries(series.id, { defaultStyleId: created.id });
                    }, 400);
                  })
                }
              >
                <Plus className="h-3.5 w-3.5" />
                Create one
              </Button>
            </div>
          ) : (
            <StylePackEditor
              packId={pack.id}
              anchors={pack.anchors}
              theme={pack.theme}
              negative={pack.negative}
              model={pack.recommendedModelId}
              width={pack.width}
              height={pack.height}
              models={models}
            />
          )}
        </section>

        {/* ── Cast: recurring characters with identity references ─────────────── */}
        <section className="flex flex-col gap-3 rounded-lg border border-border bg-bg/40 p-4">
          <h2 className="eyebrow">Cast — recurring characters</h2>
          {cast.length === 0 && (
            <p className="text-xs text-faint">No cast yet — add characters below so every episode keeps their identity.</p>
          )}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {cast.map((c) => (
              <CastCard
                key={c.id}
                character={c}
                onAddRef={(file) => void addCharacterRef(c.id, file)}
                onRemove={() =>
                  void patchSeries(series.id, { castIds: series.castIds.filter((x) => x !== c.id) })
                }
              />
            ))}
          </div>
          <CastPicker
            all={characters}
            memberIds={series.castIds}
            onToggle={(cid) => {
              const next = series.castIds.includes(cid)
                ? series.castIds.filter((x) => x !== cid)
                : [...series.castIds, cid];
              void patchSeries(series.id, { castIds: next });
            }}
            onCreate={async (name) => {
              const created = await createCharacter(name);
              if (created)
                void patchSeries(series.id, { castIds: [...series.castIds, created.id] });
            }}
          />
        </section>

        {/* ── Episodes ─────────────────────────────────────────────────────────── */}
        <section className="flex flex-col gap-3 rounded-lg border border-border bg-bg/40 p-4">
          <h2 className="eyebrow">Episodes · {episodes.length}</h2>
          {episodes.length === 0 && (
            <p className="text-xs text-faint">No episodes yet — paste a story to create the first one.</p>
          )}
          <div className="flex flex-col gap-1.5">
            {episodes.map((p) => (
              <EpisodeRow key={p.id} project={p} />
            ))}
          </div>
          {projects.length > episodes.length && (
            <details className="text-xs text-faint">
              <summary className="cursor-pointer select-none py-1">Link an existing project…</summary>
              <div className="flex flex-wrap gap-1.5 pt-2">
                {projects
                  .filter((p) => !series.projectIds.includes(p.id))
                  .map((p) => (
                    <button
                      key={p.id}
                      onClick={() =>
                        void patchSeries(series.id, { projectIds: [...series.projectIds, p.id] })
                      }
                      className="rounded-full border border-border px-2.5 py-1 text-[11px] text-muted hover:border-accent/60 hover:text-accent"
                    >
                      + {p.name || "Untitled"}
                    </button>
                  ))}
              </div>
            </details>
          )}
        </section>
      </div>

      {newEpisode && <DraftModal onClose={() => setNewEpisode(false)} initialSeriesId={series.id} />}
    </PageShell>
  );
}

/** Inline editor for the style pack fields the universe owns. */
function StylePackEditor({
  packId,
  anchors,
  theme,
  negative,
  model,
  width,
  height,
  models,
}: {
  packId: string;
  anchors: ComicReference[];
  theme: string;
  negative: string;
  model: string;
  width: number;
  height: number;
  models: ModelInfo[];
}) {
  const patchStylePack = useLibrary((s) => s.patchStylePack);
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);

  const upload = async (files: FileList | File[]) => {
    setBusy(true);
    try {
      for (const file of Array.from(files)) {
        if (!file.type.startsWith("image/")) continue;
        const ref = await api.uploadAsset(file);
        // Idempotent by hash; appended after existing anchors (earlier = stronger).
        if (!anchors.some((a) => a.hash === ref.hash)) {
          anchors = [...anchors, { hash: ref.hash, weight: 1 }];
          await patchStylePack(packId, { anchors });
        }
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <span className="text-[10px] uppercase tracking-wide text-faint">
          Style reference images — every frame of every episode is steered by these
        </span>
        <div
          className={cn(
            "flex flex-wrap gap-2 rounded-md border border-dashed p-2 transition",
            dragOver ? "border-accent bg-accent/5" : "border-border",
          )}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={(e) => {
            e.preventDefault();
            setDragOver(false);
          }}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            void upload(e.dataTransfer.files);
          }}
        >
          {anchors.map((a) => (
            <div key={a.hash} className="group relative">
              <img
                src={api.thumbUrl(a.hash)}
                alt="style anchor"
                className="h-20 w-20 rounded-md border border-border object-cover"
              />
              <button
                title="Remove"
                onClick={() =>
                  void patchStylePack(packId, { anchors: anchors.filter((x) => x.hash !== a.hash) })
                }
                className="absolute -right-1.5 -top-1.5 hidden rounded-full bg-bg p-0.5 text-down shadow group-hover:block"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
          <button
            onClick={() => fileRef.current?.click()}
            disabled={busy}
            title="Upload style references (or drop them here)"
            className="flex h-20 w-20 flex-col items-center justify-center gap-1 rounded-md border border-dashed border-border text-faint transition hover:border-accent/60 hover:text-accent"
          >
            <ImagePlus className="h-4 w-4" />
            <span className="text-[10px]">{busy ? "…" : "Add"}</span>
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => e.target.files && void upload(e.target.files)}
          />
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-[10px] uppercase tracking-wide text-faint">Style prompt (theme)</span>
        <SyncedTextarea
          className="min-h-16 text-xs"
          value={theme}
          onCommit={(v) => void patchStylePack(packId, { theme: v })}
        />
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="col-span-2 flex flex-col gap-1.5">
          <span className="text-[10px] uppercase tracking-wide text-faint">Model</span>
          <Select
            value={model}
            onChange={(e) => void patchStylePack(packId, { recommendedModelId: e.target.value })}
            className="h-8 text-[11px]"
          >
            <option value="">— project default —</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.displayName}
              </option>
            ))}
          </Select>
        </div>
        <LabeledNumber label="Width" value={width} onCommit={(v) => void patchStylePack(packId, { width: v })} />
        <LabeledNumber label="Height" value={height} onCommit={(v) => void patchStylePack(packId, { height: v })} />
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-[10px] uppercase tracking-wide text-faint">Negative prompt</span>
        <SyncedTextarea
          className="min-h-12 text-xs"
          value={negative || DEFAULT_NEGATIVE}
          onCommit={(v) => void patchStylePack(packId, { negative: v })}
        />
      </div>
    </div>
  );
}

function LabeledNumber({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: number;
  onCommit: (v: number) => void;
}) {
  const [local, setLocal] = useState(String(value));
  const commit = () => {
    const n = Math.max(64, Math.round(parseInt(local, 10) || 0));
    if (n !== value) onCommit(n);
    setLocal(String(n));
  };
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[10px] uppercase tracking-wide text-faint">{label}</span>
      <Input
        className="h-8 text-xs"
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && commit()}
      />
    </div>
  );
}

/** One recurring character: identity references, aliases, link to the full system. */
function CastCard({
  character,
  onAddRef,
  onRemove,
}: {
  character: ReturnType<typeof useLibrary.getState>["library"]["characters"][number];
  onAddRef: (file: File) => void;
  onRemove: () => void;
}) {
  const patchCharacter = useLibrary((s) => s.patchCharacter);
  const fileRef = useRef<HTMLInputElement>(null);
  const [newAlias, setNewAlias] = useState("");
  const [dragOver, setDragOver] = useState(false);

  const addAlias = () => {
    const a = newAlias.trim().toLowerCase();
    setNewAlias("");
    if (!a || character.aliases.includes(a)) return;
    void patchCharacter(character.id, { aliases: [...character.aliases, a] });
  };

  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-lg border border-border bg-surface p-3 transition",
        dragOver && "border-accent",
      )}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={(e) => {
        e.preventDefault();
        setDragOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const file = Array.from(e.dataTransfer.files).find((f) => f.type.startsWith("image/"));
        if (file) onAddRef(file);
      }}
    >
      <div className="flex items-center gap-2">
        {character.refHashes[0] ? (
          <img
            src={api.thumbUrl(character.refHashes[0])}
            alt=""
            className="h-9 w-9 rounded-full border border-border object-cover"
          />
        ) : (
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-elevated text-xs text-muted">
            {character.name.slice(0, 1)}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <Link
            to={`/library/characters/${character.id}`}
            className="block truncate text-xs font-medium text-text hover:text-accent"
          >
            {character.name || "Unnamed"}
          </Link>
          {character.description && (
            <p className="truncate text-[10px] text-faint">{character.description}</p>
          )}
        </div>
        <button title="Remove from this universe" onClick={onRemove} className="text-faint hover:text-down">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {character.refHashes.slice(0, 8).map((h) => (
          <img
            key={h}
            src={api.thumbUrl(h)}
            alt="identity ref"
            className="h-10 w-10 rounded-md border border-border object-cover"
          />
        ))}
        <button
          onClick={() => fileRef.current?.click()}
          title="Upload an identity reference (drag-drop works too)"
          className="flex h-10 w-10 items-center justify-center rounded-md border border-dashed border-border text-faint hover:border-accent/60 hover:text-accent"
        >
          <ImagePlus className="h-3.5 w-3.5" />
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onAddRef(f);
            e.target.value = "";
          }}
        />
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {character.aliases.map((a) => (
          <TagChip
            key={a}
            label={a}
            onRemove={() =>
              void patchCharacter(character.id, { aliases: character.aliases.filter((x) => x !== a) })
            }
          />
        ))}
        <input
          value={newAlias}
          onChange={(e) => setNewAlias(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addAlias()}
          onBlur={addAlias}
          placeholder="alias ⏎"
          className="w-20 rounded-full border border-dashed border-border bg-transparent px-2 py-0.5 text-[10px] text-muted outline-none focus:border-accent/60"
        />
      </div>
    </div>
  );
}

/** Pick recurring characters from the library (or create one on the spot). */
function CastPicker({
  all,
  memberIds,
  onToggle,
  onCreate,
}: {
  all: ReturnType<typeof useLibrary.getState>["library"]["characters"];
  memberIds: string[];
  onToggle: (id: string) => void;
  onCreate: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-[10px] uppercase tracking-wide text-faint">Add:</span>
      {all
        .filter((c) => !memberIds.includes(c.id))
        .map((c) => (
          <button
            key={c.id}
            onClick={() => onToggle(c.id)}
            className="rounded-full border border-border px-2.5 py-1 text-[11px] text-muted hover:border-accent/60 hover:text-accent"
          >
            + {c.name || "Unnamed"}
          </button>
        ))}
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && name.trim()) {
            void onCreate(name.trim());
            setName("");
          }
        }}
        placeholder="new character ⏎"
        className="w-32 rounded-full border border-dashed border-border bg-transparent px-2.5 py-1 text-[11px] text-muted outline-none focus:border-accent/60"
      />
    </div>
  );
}

function EpisodeRow({ project }: { project: ProjectSummary }) {
  const navigate = useNavigate();
  const loadProject = useComic((s) => s.loadProject);
  const open = async () => {
    try {
      await loadProject(project.id);
      navigate("/");
    } catch {
      toastError();
    }
  };
  return (
    <button
      onClick={() => void open()}
      className="flex items-center gap-3 rounded-md border border-border bg-surface px-3 py-2 text-left transition hover:border-accent/60"
    >
      {project.coverHash ? (
        <img src={api.thumbUrl(project.coverHash)} alt="" className="h-9 w-9 rounded border border-border object-cover" />
      ) : (
        <span className="flex h-9 w-9 items-center justify-center rounded bg-elevated text-[10px] text-faint">◎</span>
      )}
      <span className="min-w-0 flex-1 truncate text-xs text-text">{project.name || "Untitled"}</span>
      <span className="shrink-0 text-[10px] text-faint">
        {project.frameCount} frame{project.frameCount === 1 ? "" : "s"} ·{" "}
        {new Date(project.updatedAt).toLocaleDateString()}
      </span>
    </button>
  );
}

function toastError() {
  import("sonner").then(({ toast }) => toast.error("Couldn't open the episode"));
}

function TagChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="flex items-center gap-1 rounded-full bg-elevated px-2 py-0.5 text-[11px] text-muted">
      {label}
      <button onClick={onRemove} className="text-faint hover:text-down">
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}
