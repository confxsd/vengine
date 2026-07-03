import { useMemo, useState } from "react";
import { Loader2, Search, Star } from "lucide-react";
import { STUDY_CATEGORIES, studyImageHash, type StudyCategory } from "@vengine/shared";
import type { CharacterStudy } from "../types";
import { api } from "../api";
import { Input } from "../components/ui";
import { cn } from "@/lib/cn";
import { CATEGORY_ICONS, CATEGORY_ORDER } from "./studyCategories";

type Filter = StudyCategory | "all";

/**
 * The right-panel **system library**: every study of this character organised
 * into shelves by category, filterable and searchable. Starred (canonical)
 * studies lead their shelf. Clicking a card puts it on the workbench.
 */
export function StudyShelves({
  studies,
  busy,
  selectedId,
  onSelect,
}: {
  studies: CharacterStudy[];
  busy: Record<string, boolean>;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return studies.filter(
      (s) =>
        (filter === "all" || s.category === filter) &&
        (!q ||
          s.title.toLowerCase().includes(q) ||
          s.prompt.toLowerCase().includes(q) ||
          s.notes.toLowerCase().includes(q)),
    );
  }, [studies, filter, query]);

  const shelves = useMemo(() => {
    const byCategory = new Map<StudyCategory, CharacterStudy[]>();
    for (const s of visible) {
      const shelf = byCategory.get(s.category) ?? [];
      shelf.push(s);
      byCategory.set(s.category, shelf);
    }
    // Canonical first, then newest first — the shelf reads "the reference, then takes".
    for (const shelf of byCategory.values()) {
      shelf.sort((a, b) => Number(b.starred) - Number(a.starred));
    }
    return CATEGORY_ORDER.filter((c) => byCategory.has(c)).map((c) => ({
      category: c,
      items: byCategory.get(c)!,
    }));
  }, [visible]);

  const countFor = (c: Filter) =>
    c === "all" ? studies.length : studies.filter((s) => s.category === c).length;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-col gap-2 border-b border-border p-3">
        <span className="eyebrow">System library</span>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint" />
          <Input
            className="h-7 pl-7"
            value={query}
            placeholder="Search studies…"
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="flex flex-wrap gap-1">
          {(["all", ...CATEGORY_ORDER] as Filter[]).map((c) => {
            const active = filter === c;
            const count = countFor(c);
            return (
              <button
                key={c}
                type="button"
                onClick={() => setFilter(c)}
                className={cn(
                  "rounded-full px-2 py-0.5 text-[10px] font-medium capitalize transition-colors",
                  active ? "bg-accent/15 text-accent" : "text-faint hover:bg-elevated hover:text-muted",
                )}
              >
                {c === "all" ? "All" : STUDY_CATEGORIES[c].label}
                {count > 0 && <span className="ml-1 opacity-60">{count}</span>}
              </button>
            );
          })}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {shelves.length === 0 ? (
          <p className="px-1 py-6 text-center text-[11px] leading-relaxed text-faint">
            {studies.length === 0
              ? "The system is empty — generate the first study and it lands here, organised by shelf."
              : "Nothing matches this filter."}
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            {shelves.map(({ category, items }) => {
              const Icon = CATEGORY_ICONS[category];
              return (
                <section key={category} className="flex flex-col gap-1.5">
                  <div className="flex items-center gap-1.5">
                    <Icon className="h-3 w-3 text-faint" />
                    <span className="eyebrow">
                      {STUDY_CATEGORIES[category].label} · {items.length}
                    </span>
                  </div>
                  <div className="grid grid-cols-3 gap-1.5">
                    {items.map((s) => (
                      <StudyCard
                        key={s.id}
                        study={s}
                        busy={!!busy[s.id]}
                        selected={s.id === selectedId}
                        onSelect={() => onSelect(s.id)}
                      />
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function StudyCard({
  study,
  busy,
  selected,
  onSelect,
}: {
  study: CharacterStudy;
  busy: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const cover = studyImageHash(study);
  const meta = STUDY_CATEGORIES[study.category];
  const label = study.title || meta.label;
  return (
    <button
      type="button"
      onClick={onSelect}
      title={study.prompt || label}
      className="group flex min-w-0 flex-col gap-1 text-left"
    >
      <div
        className={cn(
          "relative aspect-square w-full overflow-hidden rounded-md ring-1 transition",
          selected ? "ring-2 ring-accent" : "ring-border group-hover:ring-border-strong",
        )}
      >
        {cover ? (
          <img src={api.thumbUrl(cover)} alt={label} className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-elevated/40 text-faint">
            {!busy && <span className="text-[9px]">pending</span>}
          </div>
        )}
        {busy && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/40">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-white" />
          </div>
        )}
        {study.starred && (
          <Star className="absolute right-1 top-1 h-3 w-3 fill-amber text-amber drop-shadow" />
        )}
        {study.variants.length > 1 && (
          <span className="absolute bottom-1 right-1 rounded bg-black/55 px-1 text-[9px] font-medium text-white">
            {study.variants.length}
          </span>
        )}
      </div>
      <span className={cn("truncate text-[10px]", selected ? "text-text" : "text-muted")}>
        {label}
      </span>
    </button>
  );
}
