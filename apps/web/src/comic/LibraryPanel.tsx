import { useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  ImageDown,
  Loader2,
  Plus,
  Sparkles,
  Trash2,
  Upload,
  UserPlus,
  X,
  Zap,
} from "lucide-react";
import { TrainingStatus, type StylePack } from "@vengine/shared";
import { useLibrary } from "../libraryStore";
import { useComic } from "../comicStore";
import { api } from "../api";
import { Badge, Button, Input, Segmented, Textarea } from "../components/ui";
import type { LibraryCharacter, TrainedLora } from "../types";
import { TrainModal } from "./TrainModal";
import { SheetImportModal } from "./SheetImportModal";
import { cn } from "@/lib/cn";

type Tab = "characters" | "styles" | "models";
const TABS = [
  { value: "characters" as const, label: "Characters" },
  { value: "styles" as const, label: "Styles" },
  { value: "models" as const, label: "Models" },
];

/**
 * Inputs that **resync to the server value while not focused**. The library is the
 * source of truth, so a record can change under us (a WS-driven refetch, a name the
 * server normalized) — an uncontrolled `defaultValue` would silently keep showing the
 * stale text and a blur could then save the stale value back. These hold local edits
 * while focused and adopt the prop otherwise, committing on blur only when changed.
 */
function SyncedInput({
  value,
  onCommit,
  className,
  placeholder,
}: {
  value: string;
  onCommit: (v: string) => void;
  className?: string;
  placeholder?: string;
}) {
  const [local, setLocal] = useState(value);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setLocal(value);
  }, [value, focused]);
  return (
    <Input
      className={className}
      placeholder={placeholder}
      value={local}
      onChange={(e) => setLocal(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        if (local !== value) onCommit(local);
      }}
    />
  );
}

function SyncedTextarea({
  value,
  onCommit,
  className,
  placeholder,
}: {
  value: string;
  onCommit: (v: string) => void;
  className?: string;
  placeholder?: string;
}) {
  const [local, setLocal] = useState(value);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setLocal(value);
  }, [value, focused]);
  return (
    <Textarea
      className={className}
      placeholder={placeholder}
      value={local}
      onChange={(e) => setLocal(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        if (local !== value) onCommit(local);
      }}
    />
  );
}

/**
 * The cross-project Library slide-over — a global overlay reachable from both the
 * Storyboard and Canvas. It both *manages* durable assets (characters, style packs,
 * trained LoRAs) and *supplies* them to the current comic (apply a style, add a
 * character to the cast, attach a LoRA). It never navigates you away from your work.
 */
export function LibraryPanel() {
  const open = useLibrary((s) => s.open);
  const setOpen = useLibrary((s) => s.setOpen);
  const toggle = useLibrary((s) => s.toggle);
  const modalOpen = useLibrary((s) => s.modalOpen);
  const [tab, setTab] = useState<Tab>("characters");

  // ⇧L toggles the panel; Esc closes it — but only when no inner modal is open (Esc
  // belongs to the modal then) and the user isn't typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement)?.tagName ?? "");
      if (e.key === "Escape" && open && !modalOpen && !typing) setOpen(false);
      if (!typing && e.shiftKey && (e.key === "L" || e.key === "l")) {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, modalOpen, setOpen, toggle]);

  return (
    <>
      {/* Backdrop (click to close). Pointer-events only when open. */}
      <div
        className={cn(
          "fixed inset-0 z-40 bg-black/30 transition-opacity",
          open ? "opacity-100" : "pointer-events-none opacity-0",
        )}
        onClick={() => setOpen(false)}
      />
      <aside
        className={cn(
          "fixed inset-y-0 right-0 z-50 flex w-[400px] max-w-[92vw] flex-col border-l border-border bg-surface shadow-2xl shadow-black/30 transition-transform duration-200",
          open ? "translate-x-0" : "translate-x-full",
        )}
        aria-hidden={!open}
      >
        <header className="flex items-center gap-2 border-b border-border px-4 py-3">
          <Sparkles className="h-4 w-4 text-accent" />
          <span className="text-sm font-semibold text-text">Library</span>
          <span className="text-[11px] text-faint">· shared across projects</span>
          <div className="flex-1" />
          <button onClick={() => setOpen(false)} className="text-faint hover:text-text">
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="border-b border-border px-3 py-2">
          <Segmented aria-label="Library section" value={tab} onChange={setTab} options={TABS} size="sm" />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {tab === "characters" && <CharactersTab />}
          {tab === "styles" && <StylesTab />}
          {tab === "models" && <ModelsTab />}
        </div>
      </aside>
    </>
  );
}

/* ─────────────────────────────── Characters ─────────────────────────────── */

function CharactersTab() {
  const characters = useLibrary((s) => s.library.characters);
  const createCharacter = useLibrary((s) => s.createCharacter);
  const [name, setName] = useState("");
  const [training, setTraining] = useState<LibraryCharacter | null>(null);
  const [importing, setImporting] = useState<LibraryCharacter | null>(null);

  const add = async () => {
    if (!name.trim()) return;
    await createCharacter(name);
    setName("");
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2">
        <Input
          value={name}
          placeholder="New character (e.g. Yue)"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void add()}
        />
        <Button variant="secondary" size="sm" onClick={() => void add()}>
          <Plus className="h-3.5 w-3.5" />
          Add
        </Button>
      </div>

      {characters.length === 0 && (
        <p className="px-1 py-6 text-center text-xs text-faint">
          No characters yet. Add Yue, the boy, or a guest — then attach references and train a LoRA.
        </p>
      )}

      {characters.map((c) => (
        <CharacterRow
          key={c.id}
          character={c}
          onTrain={() => setTraining(c)}
          onImportSheet={() => setImporting(c)}
        />
      ))}

      {training && <TrainModal character={training} onClose={() => setTraining(null)} />}
      {importing && (
        <SheetImportModal character={importing} onClose={() => setImporting(null)} />
      )}
    </div>
  );
}

function CharacterRow({
  character,
  onTrain,
  onImportSheet,
}: {
  character: LibraryCharacter;
  onTrain: () => void;
  onImportSheet: () => void;
}) {
  const patchCharacter = useLibrary((s) => s.patchCharacter);
  const deleteCharacter = useLibrary((s) => s.deleteCharacter);
  const addCharacterRef = useLibrary((s) => s.addCharacterRef);
  const lora = useLibrary((s) => s.loraById(character.loraId));
  const hasProject = useComic((s) => !!s.project);
  const addCast = useComic((s) => s.addCastFromLibrary);
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const onPick = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    for (const f of Array.from(files)) await addCharacterRef(character.id, f);
    setBusy(false);
  };

  return (
    <div className="rounded-lg border border-border bg-bg/40 p-2.5">
      <div className="flex items-center gap-2">
        <SyncedInput
          className="h-7 flex-1 text-sm"
          value={character.name}
          onCommit={(v) => void patchCharacter(character.id, { name: v })}
        />
        <LoraStatusBadge lora={lora} />
        <button
          title="Remove character"
          onClick={() => void deleteCharacter(character.id)}
          className="text-faint hover:text-down"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {character.refHashes.map((h) => (
          <img
            key={h}
            src={api.thumbUrl(h)}
            alt=""
            className="h-11 w-11 rounded-md border border-border object-cover"
          />
        ))}
        <button
          onClick={() => fileRef.current?.click()}
          className="flex h-11 w-11 items-center justify-center rounded-md border border-dashed border-border text-faint hover:border-accent/60 hover:text-muted"
          title="Add reference images"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
        </button>
        <button
          onClick={onImportSheet}
          className="flex h-11 w-11 items-center justify-center rounded-md border border-dashed border-border text-faint hover:border-accent/60 hover:text-muted"
          title="Import from a character sheet (auto-split into pose refs)"
        >
          <ImageDown className="h-4 w-4" />
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            void onPick(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      <div className="mt-2 flex items-center gap-1.5">
        <Button variant="outline" size="sm" onClick={onTrain} disabled={character.refHashes.length === 0}>
          <Zap className="h-3.5 w-3.5" />
          Train LoRA
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={!hasProject}
          title={hasProject ? "Add to the current comic's cast (with her LoRA if trained)" : "Open a comic first"}
          onClick={() =>
            addCast({
              id: character.id,
              name: character.name,
              refHashes: character.refHashes,
              // Carry the trained character LoRA only when it's ready to run.
              ...(lora?.status === TrainingStatus.Ready && lora.loraUrl
                ? { loraPath: lora.loraUrl, loraName: lora.name }
                : {}),
            })
          }
        >
          <UserPlus className="h-3.5 w-3.5" />
          Add to comic
        </Button>
      </div>
    </div>
  );
}

function LoraStatusBadge({ lora }: { lora?: TrainedLora }) {
  if (!lora) return null;
  if (lora.status === TrainingStatus.Training)
    return (
      <Badge tone="accent">
        <Loader2 className="h-2.5 w-2.5 animate-spin" />
        training
      </Badge>
    );
  if (lora.status === TrainingStatus.Ready) return <Badge tone="up">LoRA ✓</Badge>;
  return <Badge tone="down">LoRA failed</Badge>;
}

/* ───────────────────────────────── Styles ───────────────────────────────── */

function StylesTab() {
  const styles = useLibrary((s) => s.library.styles);
  const createStyle = useLibrary((s) => s.createStyle);
  const [name, setName] = useState("");

  const add = async () => {
    if (!name.trim()) return;
    await createStyle(name);
    setName("");
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2">
        <Input
          value={name}
          placeholder="New style pack (e.g. Oil Painting)"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void add()}
        />
        <Button variant="secondary" size="sm" onClick={() => void add()}>
          <Plus className="h-3.5 w-3.5" />
          Add
        </Button>
      </div>

      {styles.length === 0 && (
        <p className="px-1 py-6 text-center text-xs text-faint">
          No style packs yet. Create Oil Painting, Chinese Ink, Comic… each with its own look & negative.
        </p>
      )}

      {styles.map((s) => (
        <StyleRow key={s.id} style={s} />
      ))}
    </div>
  );
}

function StyleRow({ style }: { style: StylePack }) {
  const patchStylePack = useLibrary((s) => s.patchStylePack);
  const deleteStyle = useLibrary((s) => s.deleteStyle);
  const hasProject = useComic((s) => !!s.project);
  const patchStyle = useComic((s) => s.patchStyle);

  const apply = () => {
    // Apply the look (theme/negative/dims/model). Only overwrite the project's style
    // references / LoRAs when this pack actually carries them — a text-only pack must
    // NOT wipe the artist's uploaded anchors or attached LoRAs.
    patchStyle({
      theme: style.theme,
      negative: style.negative,
      width: style.width,
      height: style.height,
      ...(style.anchors.length ? { anchors: style.anchors } : {}),
      ...(style.loras.length ? { loras: style.loras } : {}),
      ...(style.recommendedModelId ? { model: style.recommendedModelId } : {}),
    });
  };

  return (
    <div className="rounded-lg border border-border bg-bg/40 p-2.5">
      <div className="flex items-center gap-2">
        <SyncedInput
          className="h-7 flex-1 text-sm"
          value={style.name}
          onCommit={(v) => void patchStylePack(style.id, { name: v })}
        />
        {style.builtIn && <Badge tone="outline">preset</Badge>}
        <button title="Remove style" onClick={() => void deleteStyle(style.id)} className="text-faint hover:text-down">
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      <SyncedTextarea
        className="mt-2 h-14 text-xs"
        value={style.theme}
        placeholder="Visual style — e.g. thick oil-paint impasto, visible brushwork, warm palette"
        onCommit={(v) => void patchStylePack(style.id, { theme: v })}
      />
      <SyncedInput
        className="mt-1.5 h-7 text-xs"
        value={style.negative}
        placeholder="Negative (leave empty for painterly looks)"
        onCommit={(v) => void patchStylePack(style.id, { negative: v })}
      />

      <div className="mt-2">
        <Button
          variant="outline"
          size="sm"
          disabled={!hasProject}
          title={hasProject ? "Apply this look to the current comic" : "Open a comic first"}
          onClick={apply}
        >
          <CheckCircle2 className="h-3.5 w-3.5" />
          Apply to comic
        </Button>
      </div>
    </div>
  );
}

/* ───────────────────────────────── Models ───────────────────────────────── */

function ModelsTab() {
  const loras = useLibrary((s) => s.library.trainedLoras);
  return (
    <div className="flex flex-col gap-2">
      {loras.length === 0 && (
        <p className="px-1 py-6 text-center text-xs text-faint">
          No trained models yet. Train a character on the Characters tab — jobs run in the background.
        </p>
      )}
      {loras.map((l) => (
        <LoraRow key={l.id} lora={l} />
      ))}
    </div>
  );
}

function LoraRow({ lora }: { lora: TrainedLora }) {
  const deleteLora = useLibrary((s) => s.deleteLora);
  const hasProject = useComic((s) => !!s.project);
  const project = useComic((s) => s.project);
  const patchStyle = useComic((s) => s.patchStyle);
  const ready = lora.status === TrainingStatus.Ready;

  const attach = () => {
    const existing = project?.style.loras ?? [];
    if (existing.some((l) => l.path === lora.loraUrl)) return;
    patchStyle({ loras: [...existing, { path: lora.loraUrl, scale: 1, name: lora.name }] });
  };

  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-bg/40 p-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm text-text">{lora.name || "Untitled LoRA"}</span>
          <Badge tone="neutral">{lora.kind}</Badge>
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-[11px] text-faint">
          {lora.status === TrainingStatus.Training && (
            <span className="flex items-center gap-1 text-accent">
              <Loader2 className="h-2.5 w-2.5 animate-spin" />
              training…
            </span>
          )}
          {ready && <span className="text-up">ready</span>}
          {lora.status === TrainingStatus.Failed && (
            <span className="text-down" title={lora.error}>
              failed
            </span>
          )}
          <span>· ${lora.costUsd.toFixed(2)}</span>
          <span>· {lora.baseModelId}</span>
        </div>
      </div>
      {ready && (
        <Button
          variant="outline"
          size="sm"
          disabled={!hasProject}
          title={hasProject ? "Use this LoRA in the current comic" : "Open a comic first"}
          onClick={attach}
        >
          Attach
        </Button>
      )}
      <button title="Delete" onClick={() => void deleteLora(lora.id)} className="text-faint hover:text-down">
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
