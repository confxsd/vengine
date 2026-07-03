import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Loader2, Orbit, SlidersHorizontal } from "lucide-react";
import { toast } from "sonner";
import { TrainingStatus, leadRef, studyIdFromNodeId, type StudyCategory } from "@vengine/shared";
import { useLibrary } from "../libraryStore";
import { api, connectProgress } from "../api";
import type { ModelInfo } from "../types";
import { Badge, Button, Select } from "../components/ui";
import { PageShell } from "./PageShell";
import { rememberSystemCharacter } from "../studio/lastVisited";
import { StudyComposer, type StudySettings } from "../studio/StudyComposer";
import { StudyWorkbench } from "../studio/StudyWorkbench";
import { StudyShelves } from "../studio/StudyShelves";

const newId = () => crypto.randomUUID().slice(0, 8);

/** Prefer a reference-capable real model as the default (identity refs are the
 *  studio's whole point); fall back to whatever exists. */
function defaultModelId(models: ModelInfo[]): string {
  return (
    models.find((m) => m.consumesReferences && m.provider !== "mock")?.id ??
    models.find((m) => m.consumesReferences)?.id ??
    models[0]?.id ??
    ""
  );
}

/**
 * The **Character System** studio — a full-height, three-pane workspace that
 * expands one library character into a structured reference system:
 *
 *   composer (left)   — pick a shelf, write the brief, generate takes
 *   workbench (center)— iterate on one study: select / refine / re-roll / curate
 *   shelves (right)   — the growing system library, organised by category
 *
 * Every output is a plain asset hash, so a winning study promotes straight into
 * the character's identity refs (and from there into any comic's cast).
 */
export default function CharacterSystemPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const character = useLibrary((s) => s.library.characters.find((c) => c.id === id));
  const characters = useLibrary((s) => s.library.characters);
  const styles = useLibrary((s) => s.library.styles);
  const lora = useLibrary((s) => s.loraById(character?.loraId));
  const studyBusy = useLibrary((s) => s.studyBusy);
  const generateStudy = useLibrary((s) => s.generateStudy);
  const refineStudy = useLibrary((s) => s.refineStudy);
  const patchStudy = useLibrary((s) => s.patchStudy);
  const deleteStudy = useLibrary((s) => s.deleteStudy);
  const deleteStudyVariant = useLibrary((s) => s.deleteStudyVariant);
  const patchCharacter = useLibrary((s) => s.patchCharacter);

  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [settings, setSettings] = useState<StudySettings>({
    modelId: "",
    styleId: "",
    count: 2,
    quality: "final",
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [livePreview, setLivePreview] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    api
      .models()
      .then((ms) => {
        if (cancelled) return;
        setModels(ms);
        setSettings((s) => (s.modelId ? s : { ...s, modelId: defaultModelId(ms) }));
      })
      .catch((err: Error) => toast.error("Couldn't load models", { description: err.message }));
    return () => {
      cancelled = true;
    };
  }, []);

  // Live previews stream over the shared progress socket; study node ids carry
  // their study id, so frames route straight to the right card/bench.
  useEffect(
    () =>
      connectProgress((e) => {
        const studyId = studyIdFromNodeId(e.nodeId);
        if (studyId && e.previewHash) {
          setLivePreview((p) => ({ ...p, [studyId]: e.previewHash! }));
        }
      }),
    [],
  );

  // Remember the character so the nav rail's /system entry returns here.
  useEffect(() => {
    if (character) rememberSystemCharacter(character.id);
  }, [character]);

  // Keep the bench valid: most recent study on entry, next-best after a delete,
  // and never a stale id from another character (the route swaps :id in place).
  useEffect(() => {
    if (!character) return;
    const exists = selectedId && character.studies.some((s) => s.id === selectedId);
    if (!exists) setSelectedId(character.studies.at(-1)?.id ?? null);
  }, [character, selectedId]);

  if (!character) {
    return (
      <PageShell title="Character System" icon={<Orbit className="h-4 w-4" />}>
        <p className="text-sm text-faint">This character no longer exists.</p>
        <Button className="mt-3" variant="outline" size="sm" onClick={() => navigate("/library")}>
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to Library
        </Button>
      </PageShell>
    );
  }

  const selected = character.studies.find((s) => s.id === selectedId);
  const model = models?.find((m) => m.id === settings.modelId);
  const loraReady = lora?.status === TrainingStatus.Ready && !!lora.loraUrl;
  const portrait = character.refHashes[0];

  const onGenerate = (input: {
    category: StudyCategory;
    title: string;
    prompt: string;
    seed?: number;
  }) => {
    const studyId = newId();
    setSelectedId(studyId);
    void generateStudy(character.id, {
      studyId,
      category: input.category,
      title: input.title,
      prompt: input.prompt,
      modelId: settings.modelId,
      styleId: settings.styleId,
      count: settings.count,
      quality: settings.quality,
      ...(input.seed !== undefined ? { seed: input.seed } : {}),
    });
  };

  const onReroll = () => {
    if (!selected || !selected.prompt.trim()) return;
    void generateStudy(character.id, {
      studyId: selected.id,
      category: selected.category,
      title: selected.title,
      prompt: selected.prompt,
      modelId: settings.modelId,
      // Keep the study's own style (provenance); fall back to the composer's pick.
      styleId: selected.styleId || settings.styleId,
      count: settings.count,
      quality: settings.quality,
    });
  };

  const onRefine = (input: { baseHash: string; instruction: string; mode: "tweak" | "restage" }) => {
    if (!selected) return;
    void refineStudy(character.id, selected.id, {
      ...input,
      modelId: settings.modelId,
      quality: settings.quality,
    });
  };

  const onPromote = (hash: string) => {
    void patchCharacter(character.id, { refHashes: leadRef(character.refHashes, hash) });
    toast.success("Promoted to identity references", {
      description: "This image now leads the character's refs — models weight it highest.",
    });
  };

  const onDeleteStudy = () => {
    if (!selected) return;
    void deleteStudy(character.id, selected.id);
    setSelectedId(null);
  };

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <header className="flex items-center gap-3 border-b border-border bg-surface/80 px-4 py-2.5 backdrop-blur">
        <Button variant="ghost" size="sm" onClick={() => navigate(`/library/characters/${character.id}`)}>
          <ArrowLeft className="h-3.5 w-3.5" />
        </Button>
        {portrait && (
          <img
            src={api.thumbUrl(portrait)}
            alt={character.name}
            className="h-7 w-7 rounded-md border border-border object-cover"
          />
        )}
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Orbit className="h-4 w-4 shrink-0 text-accent" />
            {/* Character switcher — hop between systems without going through the Library. */}
            <Select
              className="h-7 w-40 text-sm font-semibold"
              value={character.id}
              onChange={(e) => navigate(`/system/${e.target.value}`)}
              title="Switch character"
            >
              {characters.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name || "Unnamed"}
                </option>
              ))}
            </Select>
          </div>
          <p className="truncate text-[11px] text-faint">
            Poses, expressions, symbols & compositions — one visual language
          </p>
        </div>
        <div className="flex items-center gap-2">
          {loraReady && <Badge tone="up">LoRA ✓</Badge>}
          <Badge tone="neutral">{character.refHashes.length} refs</Badge>
          <Badge tone="neutral">{character.studies.length} studies</Badge>
        </div>
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate(`/library/characters/${character.id}`)}
          title="Identity, references & training"
        >
          <SlidersHorizontal className="h-3.5 w-3.5" />
          Identity & training
        </Button>
      </header>

      {/* Three-pane studio */}
      <div className="flex min-h-0 flex-1">
        <aside className="w-72 shrink-0 overflow-y-auto border-r border-border bg-surface/40">
          {models === null ? (
            <div className="flex items-center justify-center p-8 text-faint">
              <Loader2 className="h-4 w-4 animate-spin" />
            </div>
          ) : (
            <StudyComposer
              character={character}
              styles={styles}
              models={models}
              lora={lora}
              settings={settings}
              onSettings={(patch) => setSettings((s) => ({ ...s, ...patch }))}
              onGenerate={onGenerate}
            />
          )}
        </aside>

        <main className="min-w-0 flex-1">
          <StudyWorkbench
            study={selected}
            busy={!!selected && !!studyBusy[selected.id]}
            livePreview={selected ? livePreview[selected.id] : undefined}
            refineSupported={!model || model.consumesReferences}
            onPatch={(patch) => selected && void patchStudy(character.id, selected.id, patch)}
            onDeleteVariant={(hash) =>
              selected && void deleteStudyVariant(character.id, selected.id, hash)
            }
            onDelete={onDeleteStudy}
            onReroll={onReroll}
            onRefine={onRefine}
            onPromote={onPromote}
          />
        </main>

        <aside className="w-72 shrink-0 border-l border-border bg-surface/40">
          <StudyShelves
            studies={character.studies}
            busy={studyBusy}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
        </aside>
      </div>
    </div>
  );
}
