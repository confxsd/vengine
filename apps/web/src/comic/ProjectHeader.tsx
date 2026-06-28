import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Dices,
  Plus,
  RotateCcw,
  Upload,
  X,
} from "lucide-react";
import {
  DEFAULT_NEGATIVE,
  buildAssistContext,
  styleReferences,
  type ComicCharacter,
  type ComicReference,
} from "@vengine/shared";
import { useComic } from "../comicStore";
import { api } from "../api";
import { Button, Field, IconButton, Input, Select } from "../components/ui";
import { AssistTextarea } from "./AssistTextarea";
import { cn } from "@/lib/cn";

/** 9:16-ish vertical presets for single-drawing comics. */
const DIM_PRESETS: { label: string; w: number; h: number }[] = [
  { label: "896×1152", w: 896, h: 1152 },
  { label: "832×1216", w: 832, h: 1216 },
  { label: "768×1344", w: 768, h: 1344 },
];

function randomSeed(): number {
  return Math.floor(Math.random() * 1_000_000);
}

/** One style reference: thumbnail + a 0..1 weight slider + remove. */
function StyleRefThumb({ refItem }: { refItem: ComicReference }) {
  const { setStyleRefWeight, removeStyleRef } = useComic();
  return (
    <div className="flex flex-col items-center gap-1">
      <div className="group relative">
        <img
          src={api.thumbUrl(refItem.hash)}
          alt="style reference"
          className="h-16 w-12 rounded-md object-cover ring-1 ring-inset ring-white/10"
        />
        <button
          type="button"
          onClick={() => removeStyleRef(refItem.hash)}
          className="absolute -right-1 -top-1 hidden rounded-full bg-down p-0.5 text-white group-hover:block"
          title="Remove style reference"
        >
          <X className="h-2.5 w-2.5" />
        </button>
      </div>
      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={refItem.weight}
        onChange={(e) => setStyleRefWeight(refItem.hash, Number(e.target.value))}
        className="w-12 accent-accent"
        title={`Influence weight ${refItem.weight.toFixed(2)}`}
      />
      <span className="text-[9px] tabular-nums text-faint">{refItem.weight.toFixed(2)}</span>
    </div>
  );
}

/** Reusable reference library: bank an image once, attach it to style or any cast
 *  member without re-uploading. The single pool every reference is drawn from. */
function LibraryPanel() {
  const library = useComic((s) => s.project?.library ?? []);
  const cast = useComic((s) => s.project?.cast ?? []);
  const {
    addStyleRefFromLibrary,
    addCharacterRefFromLibrary,
    renameLibraryAsset,
    removeLibraryAsset,
  } = useComic();

  if (library.length === 0) {
    return (
      <p className="text-[10px] leading-relaxed text-faint">
        Every uploaded or “banked” reference lands here. Reuse it as a style anchor
        or a character reference across the project — no re-uploading.
      </p>
    );
  }
  const charLabel = (c: ComicCharacter, i: number) => c.name.trim() || `C${i + 1}`;
  return (
    <div className="flex flex-col gap-1.5">
      {library.map((a) => (
        <div
          key={a.hash}
          className="flex items-center gap-2 rounded-md border border-border bg-elevated/40 p-1.5"
        >
          <img
            src={api.thumbUrl(a.hash)}
            alt={a.label || "library reference"}
            className="h-12 w-9 shrink-0 rounded object-cover ring-1 ring-inset ring-white/10"
          />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <Input
              className="h-6 text-[10px]"
              placeholder="label"
              value={a.label}
              onChange={(e) => renameLibraryAsset(a.hash, e.target.value)}
            />
            <div className="flex flex-wrap items-center gap-1">
              <button
                type="button"
                onClick={() => addStyleRefFromLibrary(a.hash)}
                className="rounded bg-elevated px-1.5 py-0.5 text-[10px] text-faint transition-colors hover:text-accent"
                title="Add as a style reference"
              >
                + style
              </button>
              {cast.map((c, i) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => addCharacterRefFromLibrary(c.id, a.hash)}
                  className="rounded bg-elevated px-1.5 py-0.5 text-[10px] text-faint transition-colors hover:text-accent"
                  title={`Add as a reference for ${charLabel(c, i)}`}
                >
                  +{charLabel(c, i)}
                </button>
              ))}
            </div>
          </div>
          <IconButton
            size="icon-sm"
            label="Remove from library"
            className="hover:text-down"
            onClick={() => removeLibraryAsset(a.hash)}
          >
            <X className="h-3.5 w-3.5" />
          </IconButton>
        </div>
      ))}
    </div>
  );
}

/** One cast member: editable name + a strip of identity reference thumbnails. */
function CharacterRow({ char }: { char: ComicCharacter }) {
  const { patchCharacter, removeCharacter, uploadCharacterRef, removeCharacterRef } = useComic();
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-border bg-elevated/40 p-2">
      <div className="flex items-center gap-1.5">
        <Input
          className="flex-1"
          placeholder="Character name"
          value={char.name}
          onChange={(e) => patchCharacter(char.id, { name: e.target.value })}
        />
        <IconButton
          size="icon-sm"
          label="Remove character"
          className="hover:text-down"
          onClick={() => removeCharacter(char.id)}
        >
          <X className="h-3.5 w-3.5" />
        </IconButton>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {char.refHashes.map((h) => (
          <div key={h} className="group relative">
            <img
              src={api.thumbUrl(h)}
              alt="character reference"
              className="h-12 w-9 rounded object-cover ring-1 ring-inset ring-white/10"
            />
            <button
              type="button"
              onClick={() => removeCharacterRef(char.id, h)}
              className="absolute -right-1 -top-1 hidden rounded-full bg-down p-0.5 text-white group-hover:block"
              title="Remove reference"
            >
              <X className="h-2.5 w-2.5" />
            </button>
          </div>
        ))}
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void uploadCharacterRef(char.id, f);
            e.target.value = "";
          }}
        />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="flex h-12 w-9 items-center justify-center rounded border border-dashed border-border text-faint transition-colors hover:border-accent/60 hover:text-muted"
          title="Add reference image"
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

export function ProjectHeader() {
  const {
    project,
    models,
    setStory,
    setSettings,
    setTemplate,
    patchStyle,
    uploadStyleRef,
    clearStyleRefs,
    addCharacter,
    addLora,
    patchLora,
    removeLora,
  } = useComic();
  const fileRef = useRef<HTMLInputElement>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showLibrary, setShowLibrary] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  // Accept every image from a drop or paste and add each as a style reference.
  function ingestImages(items: DataTransferItemList | null, files: FileList | null) {
    const fromFiles = files
      ? Array.from(files).filter((f) => f.type.startsWith("image/"))
      : [];
    const fromItems = items
      ? (Array.from(items)
          .filter((it) => it.kind === "file" && it.type.startsWith("image/"))
          .map((it) => it.getAsFile())
          .filter((f): f is File => !!f))
      : [];
    const images = fromFiles.length ? fromFiles : fromItems;
    for (const file of images) void uploadStyleRef(file);
    return images.length > 0;
  }

  // Paste image(s) anywhere in the panel to add them as style references.
  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      if (e.clipboardData && ingestImages(e.clipboardData.items, e.clipboardData.files)) {
        e.preventDefault();
      }
    }
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!project) return null;
  const { style } = project;
  const anchors = styleReferences(style);

  // Capability-aware advisories: a reference/LoRA set on a model that ignores it is
  // a silent no-op, so warn and point at a compatible model.
  const selectedModel = models.find((m) => m.id === style.model);
  const hasReferences =
    anchors.length > 0 || project.cast.some((c) => c.refHashes.length > 0);
  const hasLoras = style.loras.some((l) => l.path.trim());
  const refModels = models.filter((m) => m.consumesReferences).map((m) => m.displayName);
  const loraModels = models.filter((m) => m.consumesLoras).map((m) => m.displayName);
  const refWarning =
    hasReferences && selectedModel && !selectedModel.consumesReferences
      ? `“${selectedModel.displayName}” ignores reference images. For style/character consistency, pick a reference-capable model${refModels.length ? ` (e.g. ${refModels.join(", ")})` : ""}.`
      : null;
  const loraWarning =
    hasLoras && selectedModel && !selectedModel.consumesLoras
      ? `“${selectedModel.displayName}” ignores LoRAs${loraModels.length ? ` — use ${loraModels.join(", ")}` : ""}.`
      : null;

  const dropHandlers = {
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(true);
    },
    onDragLeave: (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      ingestImages(e.dataTransfer.items, e.dataTransfer.files);
    },
  };

  return (
    <div className="flex flex-col gap-5 p-4">
      {/* Story */}
      <section className="flex flex-col gap-2">
        <h2 className="eyebrow">Story</h2>
        <Field label="Main story">
          <AssistTextarea
            field="story"
            className="h-20"
            placeholder="The overall narrative arc…"
            value={project.story}
            onValueChange={setStory}
            context={buildAssistContext(project, "story")}
          />
        </Field>
        <Field label="Settings">
          <AssistTextarea
            field="settings"
            className="h-16"
            placeholder="World / setting shared by every frame…"
            value={project.settings}
            onValueChange={setSettings}
            context={buildAssistContext(project, "settings")}
          />
        </Field>
      </section>

      {/* Style */}
      <section className="flex flex-col gap-2">
        <h2 className="eyebrow">Visual style</h2>
        <Field label="Style theme">
          <AssistTextarea
            field="styleTheme"
            className="h-16"
            placeholder="e.g. muted ink wash, heavy grain, cinematic lighting"
            value={style.theme}
            onValueChange={(v) => patchStyle({ theme: v })}
            context={buildAssistContext(project, "styleTheme")}
          />
        </Field>

        <Field label="Model">
          <Select
            value={style.model}
            onChange={(e) => patchStyle({ model: e.target.value })}
          >
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.displayName}
              </option>
            ))}
          </Select>
          {(refWarning || loraWarning) && (
            <div className="mt-1 flex flex-col gap-1">
              {refWarning && (
                <p className="rounded-md bg-amber/12 px-2 py-1 text-[10px] leading-relaxed text-amber">
                  {refWarning}
                </p>
              )}
              {loraWarning && (
                <p className="rounded-md bg-amber/12 px-2 py-1 text-[10px] leading-relaxed text-amber">
                  {loraWarning}
                </p>
              )}
            </div>
          )}
        </Field>

        <div className="flex items-end gap-2">
          <Field label="Locked seed" className="flex-1">
            <Input
              type="number"
              value={style.seed}
              onChange={(e) => patchStyle({ seed: Number(e.target.value) })}
            />
          </Field>
          <IconButton
            variant="secondary"
            label="Randomize the shared seed"
            onClick={() => patchStyle({ seed: randomSeed() })}
          >
            <Dices className="h-4 w-4" />
          </IconButton>
        </div>

        <div className="flex flex-col gap-1">
          <span className="eyebrow">Dimensions (9:16)</span>
          <div className="flex gap-1.5">
            {DIM_PRESETS.map((p) => {
              const active = style.width === p.w && style.height === p.h;
              return (
                <button
                  key={p.label}
                  onClick={() => patchStyle({ width: p.w, height: p.h })}
                  className={cn(
                    "flex-1 rounded-md px-1.5 py-1 text-[10px] font-medium transition-colors",
                    active
                      ? "bg-accent-soft text-accent ring-1 ring-accent/40"
                      : "bg-elevated text-muted hover:text-text",
                  )}
                >
                  {p.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Style references — multiple, weighted, ordered */}
        <div className="flex flex-col gap-1.5" {...dropHandlers}>
          <div className="flex items-center justify-between">
            <span className="eyebrow">Style references</span>
            {anchors.length > 0 && (
              <button
                onClick={clearStyleRefs}
                className="text-[10px] text-faint hover:text-down"
              >
                clear all
              </button>
            )}
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => {
              for (const f of Array.from(e.target.files ?? [])) void uploadStyleRef(f);
              e.target.value = "";
            }}
          />
          <div
            className={cn(
              "flex flex-wrap items-start gap-2 rounded-md transition-colors",
              dragOver && "p-1 outline-2 outline-dashed outline-accent",
            )}
          >
            {anchors.map((ref) => (
              <StyleRefThumb key={ref.hash} refItem={ref} />
            ))}
            <button
              onClick={() => fileRef.current?.click()}
              className={cn(
                "flex h-16 w-12 flex-col items-center justify-center gap-1 rounded-md border border-dashed text-[10px] transition-colors",
                dragOver
                  ? "border-accent bg-accent-soft text-accent"
                  : "border-border text-faint hover:border-accent/60 hover:text-muted",
              )}
              title="Add style reference image(s)"
            >
              <Upload className="h-4 w-4" />
              add
            </button>
          </div>
          <p className="text-[10px] leading-relaxed text-faint">
            Drag, drop, or paste one or more images — or “★ as style ref” on a
            frame. Earlier and higher-weight references steer the look more, on
            reference-capable models.
          </p>
        </div>

        {/* House-style LoRAs */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="eyebrow">Style LoRAs</span>
            <button
              onClick={addLora}
              className="flex items-center gap-0.5 text-[10px] text-faint hover:text-accent"
            >
              <Plus className="h-3 w-3" />
              add
            </button>
          </div>
          {style.loras.length > 0 && (
            <div className="flex flex-col gap-1.5">
              {style.loras.map((l, i) => (
                <div key={i} className="flex items-center gap-1.5">
                  <Input
                    className="flex-1"
                    placeholder="LoRA URL or hub id (.safetensors)"
                    value={l.path}
                    onChange={(e) => patchLora(i, { path: e.target.value })}
                  />
                  <Input
                    className="w-16"
                    type="number"
                    step="0.05"
                    value={l.scale}
                    onChange={(e) => patchLora(i, { scale: Number(e.target.value) })}
                    title="LoRA scale (1 = full strength)"
                  />
                  <IconButton
                    size="icon-sm"
                    label="Remove LoRA"
                    className="hover:text-down"
                    onClick={() => removeLora(i)}
                  >
                    <X className="h-3.5 w-3.5" />
                  </IconButton>
                </div>
              ))}
            </div>
          )}
          <p className="text-[10px] leading-relaxed text-faint">
            Applied on LoRA-capable models (e.g. “FLUX.2 [dev] + LoRA”). A trained
            style LoRA is the strongest house-style lock; ignored by other models.
          </p>
        </div>
      </section>

      {/* Cast — recurring characters fed as identity references */}
      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h2 className="eyebrow">Cast (characters)</h2>
          <Button variant="secondary" size="sm" onClick={addCharacter}>
            <Plus className="h-3.5 w-3.5" />
            Add
          </Button>
        </div>
        {project.cast.length === 0 ? (
          <p className="text-[10px] leading-relaxed text-faint">
            Add a recurring character and attach reference images (or “as ref” a
            generated frame). Its identity is fed into every frame the character
            appears in — character consistency across panels, on reference-capable
            models.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {project.cast.map((c) => (
              <CharacterRow key={c.id} char={c} />
            ))}
          </div>
        )}
      </section>

      {/* Reusable reference library */}
      <section className="flex flex-col gap-2">
        <button
          onClick={() => setShowLibrary((v) => !v)}
          className="flex items-center gap-1 text-left"
        >
          {showLibrary ? (
            <ChevronDown className="h-3 w-3 text-faint" />
          ) : (
            <ChevronRight className="h-3 w-3 text-faint" />
          )}
          <span className="eyebrow">
            Reference library{project.library.length > 0 ? ` (${project.library.length})` : ""}
          </span>
        </button>
        {showLibrary && <LibraryPanel />}
      </section>

      {/* Advanced: template + negative */}
      <section className="flex flex-col gap-2">
        <button
          onClick={() => setShowAdvanced((v) => !v)}
          className="flex items-center gap-1 text-left"
        >
          {showAdvanced ? (
            <ChevronDown className="h-3 w-3 text-faint" />
          ) : (
            <ChevronRight className="h-3 w-3 text-faint" />
          )}
          <span className="eyebrow">Advanced</span>
        </button>
        {showAdvanced && (
          <>
            <Field label="Prompt template">
              <AssistTextarea
                field="promptTemplate"
                className="h-20 font-mono"
                value={project.promptTemplate}
                onValueChange={setTemplate}
                context={buildAssistContext(project, "promptTemplate")}
              />
              <span className="text-[10px] text-faint">
                Tokens: {"{frame} {settings} {style} {story}"}
              </span>
            </Field>
            <Field label="Negative prompt">
              <AssistTextarea
                field="negativePrompt"
                className="h-16"
                value={style.negative}
                onValueChange={(v) => patchStyle({ negative: v })}
                context={buildAssistContext(project, "negativePrompt")}
              />
              <button
                onClick={() => patchStyle({ negative: DEFAULT_NEGATIVE })}
                className="flex items-center gap-1 self-start text-[10px] text-faint hover:text-muted"
              >
                <RotateCcw className="h-3 w-3" />
                reset to default (no-text)
              </button>
            </Field>
          </>
        )}
      </section>
    </div>
  );
}
