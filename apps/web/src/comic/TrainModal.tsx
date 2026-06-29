import { useEffect, useState } from "react";
import { Loader2, X, Zap } from "lucide-react";
import { LoraKind } from "@vengine/shared";
import { useLibrary } from "../libraryStore";
import { api } from "../api";
import { Button, Field, Input, Select } from "../components/ui";
import type { LibraryCharacter } from "../types";

interface Props {
  character: LibraryCharacter;
  onClose: () => void;
}

const MIN_STEPS = 200;

/**
 * Launches a LoRA training job for a Library character. The dataset is the
 * character's existing reference images (already in the asset store — never
 * re-uploaded), so this is just: pick a trainer, name it, set steps, and fire. The
 * job runs server-side; this modal closes immediately and progress shows live in
 * the Library's Models tab.
 */
export function TrainModal({ character, onClose }: Props) {
  const trainers = useLibrary((s) => s.trainers);
  const startTraining = useLibrary((s) => s.startTraining);
  const setModalOpen = useLibrary((s) => s.setModalOpen);

  const [trainerId, setTrainerId] = useState(trainers[0]?.id ?? "fal/flux-2-trainer");
  const [name, setName] = useState(`${character.name || "Character"} LoRA`);
  const [trigger, setTrigger] = useState(
    (character.name || "CHAR").toUpperCase().replace(/\s+/g, ""),
  );
  const [steps, setSteps] = useState(1000);
  const [busy, setBusy] = useState(false);

  // Tell the Library panel a modal is up, so its Esc handler yields (Esc closes this
  // modal, not the whole panel). Cleared on unmount.
  useEffect(() => {
    setModalOpen(true);
    return () => setModalOpen(false);
  }, [setModalOpen]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const count = character.refHashes.length;
  const tooFew = count < 4;
  const est = (trainers.find((t) => t.id === trainerId)?.pricePerStep ?? 0) * steps;

  const start = async () => {
    setBusy(true);
    try {
      await startTraining({
        trainerId,
        name: name.trim() || `${character.name} LoRA`,
        kind: LoraKind.Subject,
        refHashes: character.refHashes,
        triggerWord: trigger.trim() || undefined,
        characterId: character.id,
        steps,
      });
      onClose();
    } catch {
      setBusy(false); // error already toasted; keep the modal open to retry
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex w-full max-w-lg flex-col gap-4 rounded-xl border border-border bg-surface p-5 shadow-2xl shadow-black/40"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-text">
            <Zap className="h-4 w-4 text-accent" />
            Train a LoRA for {character.name || "this character"}
          </h2>
          <button onClick={onClose} className="text-faint hover:text-text">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Dataset preview */}
        <div>
          <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-faint">
            Dataset · {count} image{count === 1 ? "" : "s"}
          </div>
          {count === 0 ? (
            <p className="text-xs text-down">
              Add reference images to this character first — they become the training set.
            </p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {character.refHashes.slice(0, 12).map((h) => (
                <img
                  key={h}
                  src={api.thumbUrl(h)}
                  alt=""
                  className="h-12 w-12 rounded-md border border-border object-cover"
                />
              ))}
            </div>
          )}
          {tooFew && count > 0 && (
            <p className="mt-1.5 text-[11px] text-down/90">
              Tip: 10–20 varied images (the turnaround + expression crops) give a much stronger lock.
            </p>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Trainer">
            <Select value={trainerId} onChange={(e) => setTrainerId(e.target.value)}>
              {trainers.length === 0 && <option value="fal/flux-2-trainer">FLUX.2 Trainer</option>}
              {trainers.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.displayName}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="LoRA name">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Trigger word">
            <Input value={trigger} onChange={(e) => setTrigger(e.target.value)} placeholder="YUE" />
          </Field>
          <Field label="Steps">
            <Input
              type="number"
              min={MIN_STEPS}
              max={4000}
              step={100}
              value={steps}
              onChange={(e) => setSteps(Math.max(MIN_STEPS, Number(e.target.value) || 1000))}
            />
          </Field>
        </div>

        <div className="flex items-center justify-between border-t border-border pt-3">
          <span className="font-mono text-xs text-muted">
            ≈ ${est.toFixed(2)} · ~{Math.ceil(steps / 100)} min
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button variant="accent" size="sm" onClick={start} disabled={busy || count === 0}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
              Start training
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
