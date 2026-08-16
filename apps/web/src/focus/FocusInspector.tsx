import { useState } from "react";
import {
  Copy,
  Dices,
  Download,
  GitFork,
  Images,
  PencilRuler,
  Play,
  Sparkles,
  Square,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useStudio } from "../store";
import { useLibrary } from "../libraryStore";
import { api } from "../api";
import type { ModelInfo } from "../types";
import { Button, Field, IconButton, Input, Segmented, Select } from "../components/ui";
import { SyncedTextarea } from "../components/SyncedInput";
import { useAnchoredMenu } from "../lib/useAnchoredMenu";
import { useFocus, modelLabel, type EditMode, type FocusNodeParams, type FocusRef } from "./focusStore";

const MODE_OPTIONS = [
  { value: "tweak" as const, label: "Tweak" },
  { value: "restage" as const, label: "Re-stage" },
];

const MODE_HINT: Record<EditMode, string> = {
  tweak: "Change only what you describe — keep composition, lighting & style.",
  restage: "Keep the look & identity, but allow a new pose, angle or layout.",
};

const SPLIT_OPTIONS = [
  { value: "2", label: "2" },
  { value: "3", label: "3" },
  { value: "4", label: "4" },
];

function mergeRefs(existing: FocusRef[], incoming: FocusRef[]): FocusRef[] {
  const byHash = new Map<string, FocusRef>();
  for (const ref of [...existing, ...incoming]) {
    if (!byHash.has(ref.hash)) byHash.set(ref.hash, ref);
  }
  return [...byHash.values()];
}

/**
 * The right-panel studio for the selected edit node: what to change (instruction +
 * tweak/restage intent), how it should look (style pack, secondary references),
 * and the explore controls (seed roll, divergence split, run this branch). The
 * engine underneath treats the whole tree as one graph — this panel just edits one
 * node of it.
 */
export function FocusInspector({
  models,
  onUpload,
}: {
  models: ModelInfo[];
  onUpload: (file: File) => Promise<string | undefined>;
}) {
  const selectedId = useFocus((s) => s.selectedId);
  const node = useFocus((s) => (s.selectedId ? s.nodes.find((n) => n.id === s.selectedId) : undefined));
  const parent = useFocus((s) =>
    node && node.parentId ? s.nodes.find((n) => n.id === node.parentId) : undefined,
  );
  const sessionModelId = useFocus((s) => s.session.modelId);
  const updateParams = useFocus((s) => s.updateParams);
  const duplicate = useFocus((s) => s.duplicate);
  const removeNode = useFocus((s) => s.removeNode);
  const split = useFocus((s) => s.split);
  const select = useFocus((s) => s.select);
  const runGraph = useFocus((s) => s.runGraph);
  const planRun = useFocus((s) => s.planRun);
  const cancel = useFocus((s) => s.cancel);
  const branchIds = useFocus((s) => s.branchIds);
  const running = useFocus((s) => s.running);
  const plan = useFocus((s) => s.plan);
  const visibleHash = useFocus((s) => s.visibleHash);
  const openLightbox = useStudio((s) => s.openLightbox);

  const library = useLibrary((s) => s.library);

  const [splitCount, setSplitCount] = useState("3");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [refPickerOpen, setRefPickerOpen] = useState(false);
  const refPicker = useAnchoredMenu(refPickerOpen, () => setRefPickerOpen(false));

  if (!selectedId || !node) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <PencilRuler className="h-6 w-6 text-faint" />
        <p className="text-sm font-medium text-muted">No edit selected</p>
        <p className="max-w-52 text-xs leading-relaxed text-faint">
          Click a node in the tree to tune it, or add one with the + button on any card.
        </p>
      </div>
    );
  }

  const p = node.params;
  // The header shows THIS node's own output; the tree cards fall back to the
  // parent image for pending nodes.
  const hash = node.result?.hash ?? visibleHash(node.id);
  const ownHash = node.result?.hash;
  const editable = !running;

  // The model this node will actually run on (override → session default).
  const resolvedModelId = p.model ?? sessionModelId;
  const resolvedModel = models.find((m) => m.id === resolvedModelId);
  const ignoresRefs = !!resolvedModel && !resolvedModel.consumesReferences;

  const addRefs = async (hashes: string[]) => {
    if (!hashes.length) return;
    const added = hashes.filter((h) => !p.references.some((r) => r.hash === h));
    if (added.length) {
      updateParams(node.id, { references: mergeRefs(p.references, added.map((hash) => ({ hash }))) });
    }
  };

  const applyStylePack = (styleId: string) => {
    const pack = library.styles.find((s) => s.id === styleId);
    if (!pack) return;
    const patch: Partial<FocusNodeParams> = {};
    if (pack.theme) patch.theme = pack.theme;
    if (pack.negative) patch.negativePrompt = pack.negative;
    if (pack.recommendedModelId) patch.model = pack.recommendedModelId;
    if (pack.anchors.length) patch.references = mergeRefs(p.references, pack.anchors);
    updateParams(node.id, patch);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Result header */}
      <div className="border-b border-border p-3">
        <div
          className="relative mx-auto w-full max-w-56 overflow-hidden rounded-lg ring-1 ring-inset ring-white/5"
          style={{ aspectRatio: "3 / 4" }}
        >
          {hash ? (
            <button
              type="button"
              className="block h-full w-full"
              onClick={() => openLightbox(hash)}
              title={ownHash ? "Open full size" : "Not run yet — showing the parent image"}
            >
              <img src={api.thumbUrl(hash)} alt="result" className="h-full w-full object-cover" />
            </button>
          ) : (
            <div className="flex h-full w-full items-center justify-center bg-elevated/40 text-[11px] text-faint">
              not run yet
            </div>
          )}
          {!ownHash && hash && (
            <span className="absolute inset-x-0 top-0 bg-black/60 px-2 py-0.5 text-center text-[9px] font-medium uppercase tracking-wide text-white/80">
              parent image
            </span>
          )}
          {node.result?.status === "running" && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/45 text-[11px] font-medium text-white">
              editing…
            </div>
          )}
          {node.result?.error && (
            <div className="absolute inset-x-0 bottom-0 bg-down/90 px-2 py-1 text-[10px] text-white">
              {node.result.error}
            </div>
          )}
        </div>
        <div className="mt-2 flex items-center justify-between font-mono text-[10px] text-faint">
          <span title={node.id}>{node.id}</span>
          <span className="flex items-center gap-2">
            {node.result?.cost !== undefined && <span>${node.result.cost.toFixed(4)}</span>}
            {hash && (
              <a
                href={api.assetUrl(hash)}
                download={`focus-${hash.slice(0, 8)}.png`}
                title="Download"
                className="text-muted hover:text-text"
              >
                <Download className="h-3 w-3" />
              </a>
            )}
          </span>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
        {/* Provenance */}
        <div className="flex items-center gap-2 text-[11px] text-faint">
          <span>Edits</span>
          {parent ? (
            <button
              type="button"
              className="flex items-center gap-1.5 rounded-md bg-elevated/60 px-1.5 py-0.5 hover:text-text"
              onClick={() => select(parent.id)}
              title="Select the parent edit"
            >
              {(() => {
                const h = visibleHash(parent.id);
                return h ? (
                  <img src={api.thumbUrl(h)} alt="" className="h-4 w-3 rounded-sm object-cover" />
                ) : null;
              })()}
              {parent.params.instruction ? (
                <span className="max-w-28 truncate">{parent.params.instruction}</span>
              ) : (
                "bare edit"
              )}
            </button>
          ) : (
            <span className="rounded-md bg-elevated/60 px-1.5 py-0.5">source image</span>
          )}
        </div>

        {/* Intent */}
        <Field label="Change">
          <SyncedTextarea
            className="min-h-16"
            value={p.instruction}
            placeholder={
              p.mode === "tweak"
                ? "e.g. deepen the shadows on the left; add a soft rim light"
                : "e.g. same look from a low angle, closer to the camera"
            }
            onCommit={(instruction) => updateParams(node.id, { instruction })}
          />
        </Field>

        <div className="flex flex-col gap-1">
          <span className="eyebrow">Intent</span>
          <Segmented
            aria-label="Edit mode"
            size="sm"
            value={p.mode}
            onChange={(mode) => updateParams(node.id, { mode })}
            options={MODE_OPTIONS}
          />
          <span className="text-[10px] leading-tight text-faint">{MODE_HINT[p.mode]}</span>
        </div>

        {ignoresRefs && (
          <p className="rounded-md bg-amber/10 px-2 py-1.5 text-[10px] leading-relaxed text-amber ring-1 ring-amber/30">
            <strong>{resolvedModel?.displayName}</strong> ignores image references, so this edit
            generates from the instruction alone — the source image won't anchor it. Pick an
            edit-capable model for true image editing.
          </p>
        )}

        {/* Seed */}
        <div className="flex items-center gap-2">
          <Field label="Seed" className="flex-1">
            <Input
              type="number"
              className="h-7"
              placeholder="auto"
              value={p.seed ?? ""}
              onChange={(e) =>
                updateParams(node.id, { seed: e.target.value === "" ? undefined : Number(e.target.value) })
              }
            />
          </Field>
          <Button
            variant="secondary"
            size="sm"
            className="mt-3.5"
            disabled={!editable}
            onClick={() => updateParams(node.id, { seed: Math.floor(Math.random() * 2 ** 31) })}
            title="Roll a fresh seed — a new take of the same instruction"
          >
            <Dices className="h-3.5 w-3.5" />
            Roll
          </Button>
        </div>
        <p className="-mt-2 text-[10px] leading-tight text-faint">
          No seed = reproducible (re-runs stay cached). Roll or split to explore.
        </p>

        {/* Diverge */}
        <div className="flex items-center gap-2">
          <Segmented
            aria-label="Split count"
            size="sm"
            value={splitCount}
            onChange={setSplitCount}
            options={SPLIT_OPTIONS}
          />
          <Button
            variant="secondary"
            size="sm"
            className="flex-1"
            disabled={!editable}
            onClick={() => split(node.id, Number(splitCount))}
            title="Fork this edit into N siblings with fresh seeds — the engine runs them in parallel"
          >
            <GitFork className="h-3.5 w-3.5" />
            Split {splitCount}×
          </Button>
        </div>

        {/* Style */}
        <div className="flex items-end gap-2">
          <Field label="Style pack" className="flex-1">
            <Select
              className="h-7"
              value=""
              onChange={(e) => {
                if (e.target.value) applyStylePack(e.target.value);
                e.target.value = "";
              }}
            >
              <option value="">Apply a pack…</option>
              {library.styles.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name || s.id}
                </option>
              ))}
            </Select>
          </Field>
          <Button
            variant="secondary"
            size="sm"
            className="mb-0.5"
            disabled={!editable}
            onClick={() => updateParams(node.id, { theme: undefined })}
            title="Clear the applied style theme"
          >
            Clear
          </Button>
        </div>
        {p.theme && <p className="-mt-2 line-clamp-2 text-[10px] text-faint">Theme: {p.theme}</p>}

        {/* References */}
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between">
            <span className="eyebrow">Extra refs</span>
            <div className="flex items-center gap-1">
              <label
                className="inline-flex h-6 cursor-pointer items-center gap-1 rounded px-1.5 text-[10px] font-medium text-muted hover:bg-elevated hover:text-text"
                title="Upload a reference image"
              >
                <Upload className="h-3 w-3" />
                Upload
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void onUpload(f).then((h) => { if (h) addRefs([h]); });
                    e.target.value = "";
                  }}
                />
              </label>
              <div ref={refPicker.triggerRef}>
                <button
                  type="button"
                  className="inline-flex h-6 items-center gap-1 rounded px-1.5 text-[10px] font-medium text-muted hover:bg-elevated hover:text-text"
                  onClick={() => setRefPickerOpen((o) => !o)}
                >
                  <Images className="h-3 w-3" />
                  Library
                </button>
              </div>
            </div>
          </div>

          {p.references.length === 0 ? (
            <p className="rounded-md bg-elevated/40 px-2 py-1.5 text-[10px] text-faint">
              The parent image already leads. Add style anchors or identity refs to steer the edit.
            </p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {p.references.map((r) => (
                <span
                  key={r.hash}
                  className="group inline-flex items-center gap-1 rounded bg-elevated/80 py-0.5 pl-0.5 pr-1 text-[10px] text-muted"
                  title={`${r.hash.slice(0, 12)}…${r.weight !== undefined ? ` · weight ${r.weight}` : ""}`}
                >
                  <img src={api.thumbUrl(r.hash)} alt="" className="h-5 w-4 rounded-sm object-cover" />
                  {r.weight !== undefined && r.weight < 1 && <span className="text-faint">{r.weight}</span>}
                  <button
                    type="button"
                    className="text-faint hover:text-down"
                    onClick={() =>
                      updateParams(node.id, {
                        references: p.references.filter((x) => x.hash !== r.hash),
                      })
                    }
                    aria-label="Remove reference"
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                </span>
              ))}
            </div>
          )}

          {/* Library ref picker popover */}
          {refPicker.coords && (
            <div
              ref={refPicker.menuRef}
              className="fixed z-40 max-h-72 w-72 overflow-y-auto rounded-lg border border-border bg-card p-2 shadow-xl"
              style={{ top: refPicker.coords.top, left: refPicker.coords.left }}
            >
              <RefPickerBody onPick={(h) => { addRefs([h]); setRefPickerOpen(false); }} />
            </div>
          )}
        </div>

        {/* Advanced */}
        <button
          type="button"
          className="flex items-center justify-between rounded-md px-1 py-1 text-left text-[11px] font-medium text-muted hover:bg-elevated hover:text-text"
          onClick={() => setShowAdvanced((v) => !v)}
        >
          Advanced
          <span className="text-faint">{showAdvanced ? "▾" : "▸"}</span>
        </button>
        {showAdvanced && (
          <div className="flex flex-col gap-3">
            <Field label="Negative prompt">
              <SyncedTextarea
                className="min-h-12"
                value={p.negativePrompt ?? ""}
                placeholder="Inherits the session default when empty"
                onCommit={(negativePrompt) => updateParams(node.id, { negativePrompt: negativePrompt || undefined })}
              />
            </Field>
            <Field label="Model override">
              <Select
                className="h-7"
                value={p.model ?? ""}
                onChange={(e) => updateParams(node.id, { model: e.target.value || undefined })}
              >
                <option value="">Session default</option>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {modelLabel(m)}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="flex items-center gap-2">
              <Field label="Width" className="flex-1">
                <Input
                  type="number"
                  className="h-7"
                  placeholder="session"
                  value={p.width ?? ""}
                  onChange={(e) =>
                    updateParams(node.id, { width: e.target.value === "" ? undefined : Number(e.target.value) })
                  }
                />
              </Field>
              <Field label="Height" className="flex-1">
                <Input
                  type="number"
                  className="h-7"
                  placeholder="session"
                  value={p.height ?? ""}
                  onChange={(e) =>
                    updateParams(node.id, { height: e.target.value === "" ? undefined : Number(e.target.value) })
                  }
                />
              </Field>
            </div>
            <div className="flex items-center gap-2">
              <Field label="Steps" className="flex-1">
                <Input
                  type="number"
                  className="h-7"
                  placeholder="model default"
                  value={p.steps ?? ""}
                  onChange={(e) =>
                    updateParams(node.id, { steps: e.target.value === "" ? undefined : Number(e.target.value) })
                  }
                />
              </Field>
              <Field label="Guidance" className="flex-1">
                <Input
                  type="number"
                  step="0.5"
                  className="h-7"
                  placeholder="model default"
                  value={p.guidance ?? ""}
                  onChange={(e) =>
                    updateParams(node.id, { guidance: e.target.value === "" ? undefined : Number(e.target.value) })
                  }
                />
              </Field>
            </div>
          </div>
        )}

        {/* Node actions */}
        <div className="flex items-center gap-1.5">
          <IconButton label="Duplicate this edit" onClick={() => duplicate(node.id)} disabled={!editable}>
            <Copy className="h-3.5 w-3.5" />
          </IconButton>
          <IconButton
            label="Delete this branch (and its children)"
            className="text-down"
            disabled={!editable}
            onClick={() => {
              if (confirm("Delete this edit and everything below it?")) removeNode(node.id);
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </IconButton>
          <div className="flex-1" />
          <Button
            variant="ghost"
            size="sm"
            disabled={running}
            onClick={() => void planRun(branchIds(node.id))}
            title="Dry-run cost estimate for this branch (cache-aware)"
          >
            <Sparkles className="h-3.5 w-3.5" />
            Estimate
          </Button>
        </div>
        {plan && (
          <p className="-mt-1 font-mono text-[10px] text-muted">
            ~${plan.estTotalCost.toFixed(4)} · {plan.willRunCount} run · {plan.cachedCount} cached
          </p>
        )}
      </div>

      {/* Run footer */}
      <div className="border-t border-border p-3">
        {running ? (
          <Button variant="secondary" className="w-full" onClick={() => void cancel()}>
            <Square className="h-3.5 w-3.5" />
            Cancel run
          </Button>
        ) : (
          <Button
            variant="accent"
            className="w-full"
            onClick={() => void runGraph(branchIds(node.id))}
            title="Run this node and every child below it (ancestors are cache-aware — unchanged ones stay cached)"
          >
            <Play className="h-3.5 w-3.5 fill-current" />
            Run this branch
          </Button>
        )}
      </div>
    </div>
  );
}

function RefPickerBody({ onPick }: { onPick: (hash: string) => void }) {
  const library = useLibrary((s) => s.library);
  const characters = library.characters.filter((c) => c.refHashes.length > 0);
  const scenes = library.scenes;

  return (
    <div className="flex flex-col gap-2">
      {characters.length === 0 && scenes.length === 0 && (
        <p className="px-1 py-2 text-center text-[10px] text-faint">
          No character refs or scenes yet — add some in the Library.
        </p>
      )}
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
                title="Use as a reference"
              >
                <img src={api.thumbUrl(h)} alt="" className="h-10 w-8 object-cover" />
              </button>
            ))}
          </div>
        </div>
      ))}
      {scenes.map((sc) => (
        <button
          key={sc.id}
          type="button"
          className="flex items-center gap-2 rounded-md p-1 text-left hover:bg-elevated"
          onClick={() => onPick(sc.sourceHash)}
          title="Use as a reference"
        >
          <img src={api.thumbUrl(sc.sourceHash)} alt="" className="h-10 w-8 rounded object-cover" />
          <span className="min-w-0">
            <span className="block truncate text-[11px] text-text">{sc.name || "Scene"}</span>
            <span className="block truncate text-[10px] text-faint">{sc.tags.join(" · ")}</span>
          </span>
        </button>
      ))}
    </div>
  );
}
