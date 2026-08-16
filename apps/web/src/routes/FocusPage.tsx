import { useEffect, useMemo, useState } from "react";
import { Focus, Play, Square, Calculator, ListTree } from "lucide-react";
import { toast } from "sonner";
import { api } from "../api";
import type { ModelInfo } from "../types";
import { Button } from "../components/ui";
import { useFocus, editCapableModels } from "../focus/focusStore";
import { FocusTree } from "../focus/FocusTree";
import { FocusInspector } from "../focus/FocusInspector";
import { SourcePanel } from "../focus/SourcePanel";

/**
 * Focus Mode — one image, explored in depth. A curated tree replaces the free-form
 * node canvas: the source sits at the root, every child is an instruction-driven
 * edit of its parent, splits diverge into parallel explorations, and the engine
 * (same /api/plan + /api/run as the canvas) executes ready branches concurrently
 * with content-addressed caching, so re-running an explored branch is free.
 */
export default function FocusPage() {
  const init = useFocus((s) => s.init);
  const running = useFocus((s) => s.running);
  const status = useFocus((s) => s.status);
  const plan = useFocus((s) => s.plan);
  const selectedId = useFocus((s) => s.selectedId);
  const runGraph = useFocus((s) => s.runGraph);
  const planRun = useFocus((s) => s.planRun);
  const cancel = useFocus((s) => s.cancel);
  const branchIds = useFocus((s) => s.branchIds);
  const setSource = useFocus((s) => s.setSource);
  const session = useFocus((s) => s.session);
  const updateSession = useFocus((s) => s.updateSession);

  const [models, setModels] = useState<ModelInfo[]>([]);

  useEffect(() => {
    init();
    api.models().then(setModels).catch(() => {});
  }, [init]);

  // An edit needs a reference-consuming model; default the session to the first.
  // All models are offered (the free mock is a fast offline sandbox), but
  // non-reference ones are marked — they ignore the source image.
  const editModels = useMemo(() => editCapableModels(models), [models]);
  useEffect(() => {
    if (!models.length) return;
    const preferred = editModels[0] ?? models[0];
    if (!preferred) return;
    if (!session.modelId || !models.some((m) => m.id === session.modelId)) {
      updateSession({ modelId: preferred.id });
    }
  }, [editModels, models, session.modelId, updateSession]);

  const uploadRef = async (file: File): Promise<string | undefined> => {
    try {
      return (await api.uploadAsset(file)).hash;
    } catch (err) {
      toast.error("Upload failed", { description: (err as Error).message });
      return undefined;
    }
  };

  const uploadSource = async (file: File): Promise<string | undefined> => {
    try {
      const ref = await api.uploadAsset(file);
      setSource(ref.hash);
      // A new source re-sizes the canvas to match it (edits keep the source ratio).
      if (ref.width && ref.height) {
        updateSession({ width: ref.width, height: ref.height });
      }
      return ref.hash;
    } catch (err) {
      toast.error("Upload failed", { description: (err as Error).message });
      return undefined;
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Toolbar */}
      <header className="flex items-center gap-3 border-b border-border bg-surface/80 px-4 py-2.5 backdrop-blur">
        <div className="flex items-center gap-2">
          <div className="flex h-5 w-5 items-center justify-center rounded-md bg-gradient-to-br from-accent to-purple">
            <Focus className="h-3 w-3 text-accent-contrast" />
          </div>
          <span className="text-sm font-semibold tracking-tight">Focus</span>
        </div>

        <div className="mx-1 h-5 w-px bg-border" />

        <Button variant="ghost" size="sm" disabled={running} onClick={() => void planRun(undefined)}>
          <Calculator className="h-3.5 w-3.5" />
          Estimate all
        </Button>

        {plan && (
          <span className="font-mono text-xs text-muted">
            ~${plan.estTotalCost.toFixed(4)}{" "}
            <span className="text-faint">
              ({plan.willRunCount} run · {plan.cachedCount} cached)
            </span>
          </span>
        )}

        <div className="flex-1" />

        <span className="font-mono text-xs text-faint">{status}</span>

        {running ? (
          <Button variant="secondary" size="sm" onClick={() => void cancel()}>
            <Square className="h-3.5 w-3.5" />
            Cancel
          </Button>
        ) : (
          <>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void runGraph(undefined)}
              title="Run every pending edit; the engine skips cached branches"
            >
              <ListTree className="h-3.5 w-3.5" />
              Run all
            </Button>
            <Button
              variant="accent"
              size="md"
              onClick={() => void runGraph(selectedId ? branchIds(selectedId) : undefined)}
              title="Run the selected edit and its children (ancestors stay cached when unchanged)"
            >
              <Play className="h-3.5 w-3.5 fill-current" />
              {selectedId ? "Run branch" : "Run"}
            </Button>
          </>
        )}
      </header>

      <div className="flex min-h-0 flex-1">
        <SourcePanel models={models} onUpload={uploadSource} />
        <main className="min-w-0 flex-1">
          <FocusTree onUpload={uploadSource} />
        </main>
        <aside className="w-80 shrink-0 border-l border-border bg-surface">
          <FocusInspector models={models} onUpload={uploadRef} />
        </aside>
      </div>
    </div>
  );
}
