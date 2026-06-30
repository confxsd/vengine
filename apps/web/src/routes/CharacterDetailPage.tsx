import { useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  ImageDown,
  Loader2,
  Trash2,
  Upload,
  UserCircle2,
  UserPlus,
  Zap,
} from "lucide-react";
import { TrainingStatus } from "@vengine/shared";
import { useLibrary } from "../libraryStore";
import { useComic } from "../comicStore";
import { api } from "../api";
import { Badge, Button } from "../components/ui";
import { SyncedInput, SyncedTextarea } from "../components/SyncedInput";
import { TrainModal } from "../comic/TrainModal";
import { SheetImportModal } from "../comic/SheetImportModal";
import { PageShell } from "./PageShell";

const toList = (s: string) =>
  s
    .split(/[,\n]/)
    .map((x) => x.trim())
    .filter(Boolean);

/**
 * Full-page editor for a single library character — the depth the slide-over row
 * can't show: identity description and palette anchors (which strengthen consistency
 * beyond the images), the full reference gallery with add/remove, sheet import, and
 * LoRA training. Everything writes through the same library store, so edits are
 * instantly reflected in the slide-over and the cast picker.
 */
export default function CharacterDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const character = useLibrary((s) => s.library.characters.find((c) => c.id === id));
  const patchCharacter = useLibrary((s) => s.patchCharacter);
  const addCharacterRef = useLibrary((s) => s.addCharacterRef);
  const lora = useLibrary((s) => s.loraById(character?.loraId));
  const hasProject = useComic((s) => !!s.project);
  const addCast = useComic((s) => s.addCastFromLibrary);

  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [training, setTraining] = useState(false);
  const [importing, setImporting] = useState(false);

  if (!character) {
    return (
      <PageShell title="Character" icon={<UserCircle2 className="h-4 w-4" />}>
        <p className="text-sm text-faint">This character no longer exists.</p>
        <Button className="mt-3" variant="outline" size="sm" onClick={() => navigate("/library")}>
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to Library
        </Button>
      </PageShell>
    );
  }

  const onPick = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    for (const f of Array.from(files)) await addCharacterRef(character.id, f);
    setBusy(false);
  };

  const removeRef = (hash: string) =>
    void patchCharacter(character.id, { refHashes: character.refHashes.filter((h) => h !== hash) });

  const ready = lora?.status === TrainingStatus.Ready && !!lora.loraUrl;

  return (
    <PageShell
      title={character.name || "Character"}
      subtitle="Identity, references & training"
      icon={<UserCircle2 className="h-4 w-4" />}
      actions={
        <Button variant="ghost" size="sm" onClick={() => navigate("/library")}>
          <ArrowLeft className="h-3.5 w-3.5" />
          Library
        </Button>
      }
    >
      <div className="flex flex-col gap-6">
        {/* Identity */}
        <section className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <SyncedInput
              className="h-8 max-w-xs text-sm font-semibold"
              value={character.name}
              onCommit={(v) => void patchCharacter(character.id, { name: v })}
            />
            {lora && (
              <Badge tone={ready ? "up" : lora.status === TrainingStatus.Training ? "accent" : "down"}>
                {lora.status === TrainingStatus.Training && <Loader2 className="h-2.5 w-2.5 animate-spin" />}
                {ready ? "LoRA ✓" : lora.status === TrainingStatus.Training ? "training" : "LoRA failed"}
              </Badge>
            )}
          </div>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wide text-faint">Description</span>
            <SyncedTextarea
              className="h-20 text-xs"
              value={character.description}
              placeholder="Who they are — e.g. an exiled moon-goddess in rabbit form, jade eyes, silver fur…"
              onCommit={(v) => void patchCharacter(character.id, { description: v })}
            />
          </label>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className="text-[10px] uppercase tracking-wide text-faint">Palette anchors</span>
              <SyncedInput
                className="h-7 text-xs"
                value={character.palette.join(", ")}
                placeholder="#c9a227, silver, jade"
                onCommit={(v) => void patchCharacter(character.id, { palette: toList(v) })}
              />
              {character.palette.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {character.palette.map((hex, i) => (
                    <span
                      key={`${hex}-${i}`}
                      title={hex}
                      className="h-4 w-4 rounded border border-border"
                      style={{ backgroundColor: hex }}
                    />
                  ))}
                </div>
              )}
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] uppercase tracking-wide text-faint">Tags</span>
              <SyncedInput
                className="h-7 text-xs"
                value={character.tags.join(", ")}
                placeholder="protagonist, recurring"
                onCommit={(v) => void patchCharacter(character.id, { tags: toList(v) })}
              />
            </label>
          </div>
        </section>

        {/* References */}
        <section className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-wide text-faint">
              References · {character.refHashes.length}
            </span>
            <span className="text-[11px] text-faint">most-distinctive first</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {character.refHashes.map((h) => (
              <div key={h} className="group relative">
                <img
                  src={api.thumbUrl(h)}
                  alt=""
                  className="h-20 w-20 rounded-md border border-border object-cover"
                />
                <button
                  onClick={() => removeRef(h)}
                  title="Remove reference"
                  className="absolute -right-1.5 -top-1.5 hidden h-5 w-5 items-center justify-center rounded-full bg-down text-white group-hover:flex"
                >
                  <Trash2 className="h-2.5 w-2.5" />
                </button>
              </div>
            ))}
            <button
              onClick={() => fileRef.current?.click()}
              className="flex h-20 w-20 items-center justify-center rounded-md border border-dashed border-border text-faint hover:border-accent/60 hover:text-muted"
              title="Add reference images"
            >
              {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : <Upload className="h-5 w-5" />}
            </button>
            <button
              onClick={() => setImporting(true)}
              className="flex h-20 w-20 flex-col items-center justify-center gap-1 rounded-md border border-dashed border-border text-faint hover:border-accent/60 hover:text-muted"
              title="Import from a character sheet (auto-split into pose refs)"
            >
              <ImageDown className="h-5 w-5" />
              <span className="text-[9px]">sheet</span>
            </button>
          </div>
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
        </section>

        {/* Actions */}
        <section className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
          <Button variant="outline" size="sm" onClick={() => setTraining(true)} disabled={character.refHashes.length === 0}>
            <Zap className="h-3.5 w-3.5" />
            Train LoRA
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={!hasProject}
            title={hasProject ? "Add to the current comic's cast" : "Open a comic first"}
            onClick={() =>
              addCast({
                id: character.id,
                name: character.name,
                refHashes: character.refHashes,
                ...(ready ? { loraPath: lora!.loraUrl, loraName: lora!.name } : {}),
              })
            }
          >
            <UserPlus className="h-3.5 w-3.5" />
            Add to comic
          </Button>
        </section>
      </div>

      {training && <TrainModal character={character} onClose={() => setTraining(false)} />}
      {importing && <SheetImportModal character={character} onClose={() => setImporting(false)} />}
    </PageShell>
  );
}
