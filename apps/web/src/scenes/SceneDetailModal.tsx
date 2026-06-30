import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Loader2, Send, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { SceneStatus } from "@vengine/shared";
import { useLibrary } from "../libraryStore";
import { useComic } from "../comicStore";
import { api } from "../api";
import { Badge, Button } from "../components/ui";
import { SyncedInput, SyncedTextarea } from "../components/SyncedInput";
import type { SceneBreakdown, SceneReference } from "../types";
import { sceneToPrompt } from "./sceneToPrompt";

/** Split a comma/newline list into a clean string array (drops empties). */
const toList = (s: string) =>
  s
    .split(/[,\n]/)
    .map((x) => x.trim())
    .filter(Boolean);

/**
 * Edit one saved scene's breakdown and send it to the storyboard. Every field
 * commits on blur through `patchScene` (the server merges, so a single-field edit is
 * enough). "Send to Studio" seeds a new frame with the composed prompt — composition
 * only, so the project's own style pack provides the look.
 */
export function SceneDetailModal({ scene, onClose }: { scene: SceneReference; onClose: () => void }) {
  const setModalOpen = useLibrary((s) => s.setModalOpen);
  const patchScene = useLibrary((s) => s.patchScene);
  const deleteScene = useLibrary((s) => s.deleteScene);
  const hasProject = useComic((s) => !!s.project);
  const addFrameFromScene = useComic((s) => s.addFrameFromScene);
  const navigate = useNavigate();

  const b = scene.description;
  const describing = scene.status === SceneStatus.Describing;

  useEffect(() => {
    setModalOpen(true);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      setModalOpen(false);
      window.removeEventListener("keydown", onKey);
    };
  }, [setModalOpen, onClose]);

  const patchDesc = (patch: Partial<SceneBreakdown>) =>
    void patchScene(scene.id, { description: patch });

  const sendToStudio = () => {
    if (!b) return;
    if (!hasProject) {
      toast.error("Open a comic first", { description: "Create or open a project to add this scene." });
      return;
    }
    addFrameFromScene(sceneToPrompt(b));
    toast.success("Added a frame from this scene", { description: "Opening the storyboard…" });
    onClose();
    navigate("/");
  };

  const remove = () => {
    void deleteScene(scene.id);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-4xl flex-col gap-4 rounded-xl border border-border bg-surface p-5 shadow-2xl shadow-black/40"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2">
          <SyncedInput
            className="h-8 flex-1 text-sm font-semibold"
            value={scene.name}
            onCommit={(v) => void patchScene(scene.id, { name: v })}
          />
          {describing && (
            <Badge tone="accent">
              <Loader2 className="h-2.5 w-2.5 animate-spin" />
              describing
            </Badge>
          )}
          {scene.status === SceneStatus.Failed && <Badge tone="down">failed</Badge>}
          <button onClick={onClose} className="text-faint hover:text-text">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-y-auto md:grid-cols-[280px_1fr]">
          {/* Source image + palette */}
          <div className="flex flex-col gap-3">
            <img
              src={api.assetUrl(scene.sourceHash)}
              alt=""
              className="w-full rounded-lg border border-border object-contain"
            />
            {b && b.palette.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {b.palette.map((hex, i) => (
                  <span
                    key={`${hex}-${i}`}
                    title={hex}
                    className="h-5 w-5 rounded border border-border"
                    style={{ backgroundColor: hex }}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Editable breakdown */}
          {scene.status === SceneStatus.Failed && (
            <p className="text-xs text-down">
              Description failed: {scene.error || "unknown error"}. Delete and try again, or check the
              vision model key.
            </p>
          )}
          {b && (
            <div className="flex flex-col gap-3">
              <Field label="Caption — the frame prompt">
                <SyncedTextarea
                  className="h-20 text-xs"
                  value={b.caption}
                  placeholder="A vivid one-paragraph description of the scene"
                  onCommit={(v) => patchDesc({ caption: v })}
                />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Subjects">
                  <SyncedInput
                    className="h-7 text-xs"
                    value={b.subjects.join(", ")}
                    placeholder="comma-separated"
                    onCommit={(v) => patchDesc({ subjects: toList(v) })}
                  />
                </Field>
                <Field label="Setting">
                  <SyncedInput className="h-7 text-xs" value={b.setting} onCommit={(v) => patchDesc({ setting: v })} />
                </Field>
                <Field label="Composition">
                  <SyncedInput
                    className="h-7 text-xs"
                    value={b.composition}
                    onCommit={(v) => patchDesc({ composition: v })}
                  />
                </Field>
                <Field label="Lighting">
                  <SyncedInput className="h-7 text-xs" value={b.lighting} onCommit={(v) => patchDesc({ lighting: v })} />
                </Field>
                <Field label="Mood">
                  <SyncedInput className="h-7 text-xs" value={b.mood} onCommit={(v) => patchDesc({ mood: v })} />
                </Field>
                <Field label="Palette (hex/name)">
                  <SyncedInput
                    className="h-7 text-xs"
                    value={b.palette.join(", ")}
                    placeholder="#1b2a4a, …"
                    onCommit={(v) => patchDesc({ palette: toList(v) })}
                  />
                </Field>
              </div>
              <Field label="Observed style (not applied — your style pack provides the look)">
                <SyncedInput
                  className="h-7 text-xs"
                  value={b.styleNotes}
                  onCommit={(v) => patchDesc({ styleNotes: v })}
                />
              </Field>
              <Field label="Tags">
                <SyncedInput
                  className="h-7 text-xs"
                  value={scene.tags.join(", ")}
                  placeholder="comma-separated"
                  onCommit={(v) => void patchScene(scene.id, { tags: toList(v) })}
                />
              </Field>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-border pt-3">
          <Button variant="ghost" size="sm" onClick={remove}>
            <Trash2 className="h-3.5 w-3.5" />
            Delete
          </Button>
          <Button
            variant="accent"
            size="sm"
            onClick={sendToStudio}
            disabled={!b}
            title={hasProject ? "Add a frame seeded with this scene" : "Open a comic first"}
          >
            <Send className="h-3.5 w-3.5" />
            Send to Studio
          </Button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wide text-faint">{label}</span>
      {children}
    </label>
  );
}
