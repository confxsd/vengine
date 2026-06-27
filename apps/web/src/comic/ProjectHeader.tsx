import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Dices,
  RotateCcw,
  Upload,
} from "lucide-react";
import { DEFAULT_NEGATIVE } from "@vengine/shared";
import { useComic } from "../comicStore";
import { api } from "../api";
import {
  Button,
  Field,
  IconButton,
  Input,
  Select,
  Textarea,
} from "../components/ui";
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

export function ProjectHeader() {
  const {
    project,
    models,
    setStory,
    setSettings,
    setTemplate,
    patchStyle,
    uploadAnchor,
    clearAnchor,
  } = useComic();
  const fileRef = useRef<HTMLInputElement>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const anchorHash = project?.style.anchorHash;

  // Accept the first image from a drop or paste and upload it as the anchor.
  function ingestImage(items: DataTransferItemList | null, files: FileList | null) {
    const fromFiles = files
      ? Array.from(files).find((f) => f.type.startsWith("image/"))
      : undefined;
    const fromItems = items
      ? Array.from(items)
          .find((it) => it.kind === "file" && it.type.startsWith("image/"))
          ?.getAsFile() ?? undefined
      : undefined;
    const file = fromFiles ?? fromItems;
    if (file) void uploadAnchor(file);
    return !!file;
  }

  // Paste an image anywhere in the panel to set it as the anchor.
  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      if (e.clipboardData && ingestImage(e.clipboardData.items, e.clipboardData.files)) {
        e.preventDefault();
      }
    }
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchorHash]);

  if (!project) return null;
  const { style } = project;

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
      ingestImage(e.dataTransfer.items, e.dataTransfer.files);
    },
  };

  return (
    <div className="flex flex-col gap-5 p-4">
      {/* Story */}
      <section className="flex flex-col gap-2">
        <h2 className="eyebrow">Story</h2>
        <Field label="Main story">
          <Textarea
            className="h-20"
            placeholder="The overall narrative arc…"
            value={project.story}
            onChange={(e) => setStory(e.target.value)}
          />
        </Field>
        <Field label="Settings">
          <Textarea
            className="h-16"
            placeholder="World / setting shared by every frame…"
            value={project.settings}
            onChange={(e) => setSettings(e.target.value)}
          />
        </Field>
      </section>

      {/* Style */}
      <section className="flex flex-col gap-2">
        <h2 className="eyebrow">Visual style</h2>
        <Field label="Style theme">
          <Textarea
            className="h-16"
            placeholder="e.g. muted ink wash, heavy grain, cinematic lighting"
            value={style.theme}
            onChange={(e) => patchStyle({ theme: e.target.value })}
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

        {/* Style anchor */}
        <div className="flex flex-col gap-1.5" {...dropHandlers}>
          <span className="eyebrow">Style anchor (reference)</span>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void uploadAnchor(f);
              e.target.value = "";
            }}
          />
          {style.anchorHash ? (
            <div
              className={cn(
                "flex items-center gap-2 rounded-md transition-colors",
                dragOver && "outline-2 outline-dashed outline-accent",
              )}
            >
              <img
                src={api.thumbUrl(style.anchorHash)}
                alt="anchor"
                className="h-16 w-12 rounded-md object-cover ring-1 ring-inset ring-white/10"
              />
              <div className="flex flex-col gap-1">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => fileRef.current?.click()}
                >
                  Replace
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-faint hover:text-down"
                  onClick={clearAnchor}
                >
                  Clear
                </Button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => fileRef.current?.click()}
              className={cn(
                "flex flex-col items-center justify-center gap-1.5 rounded-md border border-dashed px-2.5 py-3 text-[11px] transition-colors",
                dragOver
                  ? "border-accent bg-accent-soft text-accent"
                  : "border-border text-faint hover:border-accent/60 hover:text-muted",
              )}
            >
              <Upload className="h-4 w-4" />
              {dragOver ? (
                "Drop image to set anchor"
              ) : (
                <span className="text-center">
                  Drag &amp; drop, paste, or click to upload — or “★ set as
                  anchor” on a frame
                </span>
              )}
            </button>
          )}
          <p className="text-[10px] leading-relaxed text-faint">
            Shared seed + style theme keep frames consistent. An anchor image
            steers reference-capable models toward one look.
          </p>
        </div>
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
              <Textarea
                className="h-20 font-mono"
                value={project.promptTemplate}
                onChange={(e) => setTemplate(e.target.value)}
              />
              <span className="text-[10px] text-faint">
                Tokens: {"{frame} {settings} {style} {story}"}
              </span>
            </Field>
            <Field label="Negative prompt">
              <Textarea
                className="h-16"
                value={style.negative}
                onChange={(e) => patchStyle({ negative: e.target.value })}
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
