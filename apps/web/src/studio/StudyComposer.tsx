import { useState } from "react";
import { Sparkles } from "lucide-react";
import { STUDY_CATEGORIES, MAX_STUDY_BATCH, StudyCategory, TrainingStatus } from "@vengine/shared";
import type { LibraryCharacter, ModelInfo, StylePack, TrainedLora } from "../types";
import { Button, Field, Input, Segmented, Select, Textarea } from "../components/ui";
import { cn } from "@/lib/cn";
import { CATEGORY_ICONS, CATEGORY_ORDER } from "./studyCategories";

/** Generation settings shared by the composer and the workbench's re-roll/refine
 *  (lifted to the page so one choice of model/style/batch drives everything). */
export interface StudySettings {
  modelId: string;
  styleId: string;
  count: number;
  quality: "preview" | "final";
}

const COUNT_OPTIONS = Array.from({ length: MAX_STUDY_BATCH }, (_, i) => ({
  value: String(i + 1),
  label: String(i + 1),
}));

const QUALITY_OPTIONS = [
  { value: "preview" as const, label: "Draft" },
  { value: "final" as const, label: "Final" },
];

/**
 * The left-panel composer: pick a shelf (category), write the study brief, choose
 * style/model/batch, and generate. Each generate starts a NEW study — re-rolling
 * an existing one happens from the workbench, so the composer is always "add to
 * the system", never "accidentally overwrite".
 */
export function StudyComposer({
  character,
  styles,
  models,
  lora,
  settings,
  onSettings,
  onGenerate,
}: {
  character: LibraryCharacter;
  styles: StylePack[];
  models: ModelInfo[];
  lora?: TrainedLora;
  settings: StudySettings;
  onSettings: (patch: Partial<StudySettings>) => void;
  onGenerate: (input: {
    category: StudyCategory;
    title: string;
    prompt: string;
    seed?: number;
  }) => void;
}) {
  const [category, setCategory] = useState<StudyCategory>(StudyCategory.Pose);
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [lockSeed, setLockSeed] = useState(false);
  const [seed, setSeed] = useState<number | "">("");

  const meta = STUDY_CATEGORIES[category];
  const model = models.find((m) => m.id === settings.modelId);
  const loraReady = lora?.status === TrainingStatus.Ready && !!lora.loraUrl;
  // No image refs AND no ready LoRA → nothing anchors the likeness.
  const noIdentity = character.refHashes.length === 0 && !loraReady;
  const noRefSupport = !!model && !model.consumesReferences && character.refHashes.length > 0;

  const perImage = model?.pricing.usd ?? 0;
  const estCost = perImage * settings.count;

  const canGenerate = !!prompt.trim() && !!settings.modelId;

  const generate = () => {
    if (!canGenerate) return;
    onGenerate({
      category,
      title: title.trim(),
      prompt: prompt.trim(),
      ...(lockSeed && seed !== "" ? { seed: Number(seed) } : {}),
    });
    setTitle("");
    setPrompt("");
  };

  return (
    <div className="flex flex-col gap-3 p-4">
      <span className="eyebrow">New study</span>

      {/* Shelf picker */}
      <div className="grid grid-cols-2 gap-1">
        {CATEGORY_ORDER.map((c) => {
          const Icon = CATEGORY_ICONS[c];
          const active = c === category;
          return (
            <button
              key={c}
              type="button"
              onClick={() => setCategory(c)}
              title={STUDY_CATEGORIES[c].hint}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] font-medium transition-colors",
                active ? "bg-accent/15 text-accent" : "text-muted hover:bg-elevated hover:text-text",
              )}
            >
              <Icon className="h-3.5 w-3.5 shrink-0" />
              {STUDY_CATEGORIES[c].label}
            </button>
          );
        })}
      </div>

      <Field label="Brief">
        <Textarea
          className="min-h-24"
          value={prompt}
          placeholder={meta.hint}
          onChange={(e) => setPrompt(e.target.value)}
        />
      </Field>

      <Field label="Title (optional)">
        <Input
          className="h-7"
          value={title}
          placeholder={`e.g. ${meta.label === "Pose" ? "Moonlit leap" : meta.label}`}
          onChange={(e) => setTitle(e.target.value)}
        />
      </Field>

      <Field label="Style pack">
        <Select
          className="h-7"
          value={settings.styleId}
          onChange={(e) => onSettings({ styleId: e.target.value })}
        >
          <option value="">None — character only</option>
          {styles.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name || s.id}
            </option>
          ))}
        </Select>
      </Field>

      <Field label="Model">
        <Select
          className="h-7"
          value={settings.modelId}
          onChange={(e) => onSettings({ modelId: e.target.value })}
        >
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.displayName}
              {m.consumesReferences ? "" : " (no image refs)"}
            </option>
          ))}
        </Select>
      </Field>

      {/* Not <Field>: a wrapping <label> would forward clicks on the caption to
          the first segment button and silently flip the value. */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-col gap-1">
          <span className="eyebrow">Takes</span>
          <Segmented
            aria-label="Variant count"
            size="sm"
            value={String(settings.count)}
            onChange={(v) => onSettings({ count: Number(v) })}
            options={COUNT_OPTIONS}
          />
        </div>
        <div className="flex flex-col gap-1">
          <span className="eyebrow">Quality</span>
          <Segmented
            aria-label="Quality"
            size="sm"
            value={settings.quality}
            onChange={(quality) => onSettings({ quality })}
            options={QUALITY_OPTIONS}
          />
        </div>
      </div>

      <div className="flex items-center gap-2">
        <label className="flex items-center gap-1.5 text-xs text-muted">
          <input
            type="checkbox"
            checked={lockSeed}
            onChange={(e) => setLockSeed(e.target.checked)}
            className="h-3.5 w-3.5 accent-accent"
          />
          Lock seed
        </label>
        <Input
          type="number"
          className="h-7 w-24 text-xs"
          placeholder="random"
          disabled={!lockSeed}
          value={seed}
          onChange={(e) => setSeed(e.target.value === "" ? "" : Number(e.target.value))}
          title="Fix a seed to reproduce a run; leave unlocked to explore"
        />
      </div>

      {noIdentity && (
        <p className="rounded-md bg-amber/10 px-2.5 py-2 text-[11px] leading-relaxed text-amber ring-1 ring-amber/30">
          This character has no reference images or trained LoRA yet — studies will invent a look
          from the description alone. Add identity refs first for consistent results.
        </p>
      )}
      {noRefSupport && (
        <p className="rounded-md bg-amber/10 px-2.5 py-2 text-[11px] leading-relaxed text-amber ring-1 ring-amber/30">
          <strong>{model?.displayName}</strong> ignores reference images, so the identity refs
          won't apply. Pick a reference-capable model to lock the likeness.
        </p>
      )}

      <Button variant="accent" className="w-full" disabled={!canGenerate} onClick={generate}>
        <Sparkles className="h-3.5 w-3.5" />
        Generate {settings.count > 1 ? `${settings.count} takes` : "study"}
        {estCost > 0 && <span className="opacity-75">· ≈ ${estCost.toFixed(2)}</span>}
      </Button>
      <p className="text-center text-[10px] text-faint">
        {meta.width}×{meta.height} · identity refs
        {loraReady ? " + LoRA" : ""} feed every take
      </p>
    </div>
  );
}
