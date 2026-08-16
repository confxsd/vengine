import { useState } from "react";
import { RotateCcw, Upload, Images, Library as LibraryIcon } from "lucide-react";
import { useLibrary } from "../libraryStore";
import { api } from "../api";
import type { ModelInfo } from "../types";
import { Button, Field, Input, Segmented, Select, Textarea } from "../components/ui";
import { SyncedInput } from "../components/SyncedInput";
import { useAnchoredMenu } from "../lib/useAnchoredMenu";
import { useFocus, modelLabel, editCapableModels } from "./focusStore";

const QUALITY_OPTIONS = [
  { value: "preview" as const, label: "Draft" },
  { value: "final" as const, label: "Final" },
];

/**
 * The left session panel: the one image this whole page focuses on (upload or
 * library pick), plus the session defaults every edit node inherits (model,
 * quality, size, negative). The tree itself re-bases automatically when the
 * source changes — the engine's content addressing invalidates downstream caches.
 */
export function SourcePanel({
  models,
  onUpload,
}: {
  models: ModelInfo[];
  onUpload: (file: File) => Promise<string | undefined>;
}) {
  const sourceHash = useFocus((s) => s.sourceHash);
  const setSource = useFocus((s) => s.setSource);
  const session = useFocus((s) => s.session);
  const updateSession = useFocus((s) => s.updateSession);
  const resetTree = useFocus((s) => s.resetTree);
  const select = useFocus((s) => s.select);

  const [pickerOpen, setPickerOpen] = useState(false);
  const picker = useAnchoredMenu(pickerOpen, () => setPickerOpen(false));

  const model = models.find((m) => m.id === session.modelId);
  const perImage = model?.pricing.usd ?? 0;
  const noEditCapable = editCapableModels(models).length === 0;
  const ignoresRefs = !!model && !model.consumesReferences;

  return (
    <aside className="flex w-64 shrink-0 flex-col gap-3 overflow-y-auto border-r border-border bg-surface p-3">
      {/* Source */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <span className="eyebrow">Source image</span>
          <div ref={picker.triggerRef}>
            <button
              type="button"
              className="inline-flex h-6 items-center gap-1 rounded px-1.5 text-[10px] font-medium text-muted hover:bg-elevated hover:text-text"
              onClick={() => setPickerOpen((o) => !o)}
            >
              <LibraryIcon className="h-3 w-3" />
              Library
            </button>
          </div>
        </div>

        <div
          className="relative w-full overflow-hidden rounded-lg ring-1 ring-border"
          style={{ aspectRatio: "3 / 4" }}
        >
          {sourceHash ? (
            <img
              src={api.assetUrl(sourceHash)}
              alt="source"
              className="h-full w-full object-cover"
              // Keep the session canvas size glued to the source: every edit
              // inherits the source's ratio unless explicitly overridden. (Full
              // asset, not the thumb — thumbs are capped at 256px.)
              onLoad={(e) => {
                const img = e.currentTarget;
                if (img.naturalWidth && img.naturalHeight) {
                  updateSession({ width: img.naturalWidth, height: img.naturalHeight });
                }
              }}
            />
          ) : (
            <div className="flex h-full w-full flex-col items-center justify-center gap-1.5 bg-elevated/40 text-faint">
              <Images className="h-5 w-5" />
              <span className="text-[10px]">no source yet</span>
            </div>
          )}
        </div>

        <label className="inline-flex h-7 w-full cursor-pointer items-center justify-center gap-1.5 rounded-md border border-border-strong text-xs font-medium text-muted hover:border-accent/60 hover:text-text">
          <Upload className="h-3.5 w-3.5" />
          Upload image
          <input
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onUpload(f);
              e.target.value = "";
            }}
          />
        </label>

        {sourceHash && (
          <p className="text-[10px] leading-tight text-faint">
            Changing the source re-bases every root edit; unchanged branches stay cached.
          </p>
        )}

        {picker.coords && (
          <div
            ref={picker.menuRef}
            className="fixed z-40 max-h-80 w-80 overflow-y-auto rounded-lg border border-border bg-card p-2 shadow-xl"
            style={{ top: picker.coords.top, left: picker.coords.left }}
          >
            <SourcePickerBody
              onPick={(hash) => {
                setSource(hash);
                setPickerOpen(false);
                select(null);
              }}
            />
          </div>
        )}
      </div>

      {/* Session defaults */}
      <div className="hairline" />
      <div className="flex flex-col gap-3">
        <Field label="Study name">
          <SyncedInput
            className="h-7"
            value={session.name}
            onCommit={(name) => updateSession({ name })}
          />
        </Field>

        <Field label="Model">
          <Select
            className="h-7"
            value={session.modelId}
            onChange={(e) => updateSession({ modelId: e.target.value })}
          >
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {modelLabel(m)}
              </option>
            ))}
          </Select>
        </Field>
        {noEditCapable && (
          <p className="-mt-2 rounded-md bg-amber/10 px-2 py-1.5 text-[10px] leading-relaxed text-amber ring-1 ring-amber/30">
            No model here applies reference images, so image edits aren't available. Configure an
            edit-capable model in the server.
          </p>
        )}
        {!noEditCapable && ignoresRefs && (
          <p className="-mt-2 rounded-md bg-amber/10 px-2 py-1.5 text-[10px] leading-relaxed text-amber ring-1 ring-amber/30">
            This model ignores image references — edits generate from the instruction alone. Pick
            an edit-capable model for true image editing.
          </p>
        )}

        <div className="flex flex-col gap-1">
          <span className="eyebrow">Quality</span>
          <Segmented
            aria-label="Quality"
            size="sm"
            value={session.quality}
            onChange={(quality) => updateSession({ quality })}
            options={QUALITY_OPTIONS}
          />
        </div>

        <div className="flex items-center gap-2">
          <Field label="Width" className="flex-1">
            <Input
              type="number"
              className="h-7"
              value={session.width}
              onChange={(e) => updateSession({ width: Number(e.target.value) || 768 })}
            />
          </Field>
          <Field label="Height" className="flex-1">
            <Input
              type="number"
              className="h-7"
              value={session.height}
              onChange={(e) => updateSession({ height: Number(e.target.value) || 1344 })}
            />
          </Field>
        </div>
        <p className="-mt-2 text-[10px] leading-tight text-faint">
          Synced to the source image — every edit keeps its ratio. Override for a deliberate crop.
        </p>

        <Field label="Negative prompt">
          <Textarea
            className="min-h-12"
            value={session.negative}
            placeholder="e.g. text, watermark, blur, low detail"
            onChange={(e) => updateSession({ negative: e.target.value })}
          />
        </Field>
      </div>

      <div className="flex-1" />

      <Button
        variant="ghost"
        size="sm"
        className="w-full text-faint hover:text-down"
        onClick={() => {
          if (confirm("Clear the whole edit tree? The source image is kept.")) resetTree();
        }}
      >
        <RotateCcw className="h-3.5 w-3.5" />
        Clear tree
      </Button>
      <p className="text-center text-[10px] text-faint">
        ≈ ${perImage.toFixed(2)} per edit{model ? ` · ${model.displayName}` : ""}
      </p>
    </aside>
  );
}

/** Library assets usable as the focus source: character refs, study images, scenes. */
function SourcePickerBody({ onPick }: { onPick: (hash: string) => void }) {
  const library = useLibrary((s) => s.library);
  const characters = library.characters.filter((c) => c.refHashes.length > 0 || c.studies.length > 0);
  const scenes = library.scenes;

  const empty = characters.length === 0 && scenes.length === 0;

  return (
    <div className="flex flex-col gap-2">
      {empty && (
        <p className="px-1 py-2 text-center text-[10px] text-faint">
          Nothing here yet — upload an image instead, or add refs/scenes in the Library.
        </p>
      )}
      {scenes.map((sc) => (
        <button
          key={sc.id}
          type="button"
          className="flex items-center gap-2 rounded-md p-1 text-left hover:bg-elevated"
          onClick={() => onPick(sc.sourceHash)}
        >
          <img src={api.thumbUrl(sc.sourceHash)} alt="" className="h-11 w-9 rounded object-cover" />
          <span className="min-w-0">
            <span className="block truncate text-[11px] text-text">{sc.name || "Scene"}</span>
            <span className="block truncate text-[10px] text-faint">{sc.tags.join(" · ")}</span>
          </span>
        </button>
      ))}
      {characters.map((c) => (
        <div key={c.id} className="flex flex-col gap-1">
          <span className="eyebrow">{c.name || "Character"}</span>
          <div className="flex flex-wrap gap-1">
            {c.refHashes.map((h) => (
              <button
                key={h}
                type="button"
                className="overflow-hidden rounded ring-1 ring-border hover:ring-accent"
                onClick={() => onPick(h)}
                title={`${c.name} · identity ref`}
              >
                <img src={api.thumbUrl(h)} alt="" className="h-10 w-8 object-cover" />
              </button>
            ))}
            {c.studies.flatMap((st) =>
              st.variants.map((v) => (
                <button
                  key={v.hash}
                  type="button"
                  className="overflow-hidden rounded ring-1 ring-border hover:ring-accent"
                  onClick={() => onPick(v.hash)}
                  title={`${c.name} · ${st.title || st.category}`}
                >
                  <img src={api.thumbUrl(v.hash)} alt="" className="h-10 w-8 object-cover" />
                </button>
              )),
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
