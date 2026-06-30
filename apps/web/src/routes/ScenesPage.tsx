import { useEffect, useRef, useState } from "react";
import { Images, Loader2, UploadCloud } from "lucide-react";
import { toast } from "sonner";
import { SceneStatus } from "@vengine/shared";
import { useLibrary } from "../libraryStore";
import { api } from "../api";
import { Badge, Button } from "../components/ui";
import type { SceneConfig, SceneReference } from "../types";
import { PageShell } from "./PageShell";
import { SceneDetailModal } from "../scenes/SceneDetailModal";

/**
 * The Scenes page — the image→text surface. Upload a reference scene, a vision model
 * writes a structured breakdown, and the saved card can be edited and "sent to
 * studio" as a frame prompt. Describe runs as one (longish) request, so each upload
 * shows a placeholder card until its record lands.
 */
export default function ScenesPage() {
  const scenes = useLibrary((s) => s.library.scenes);
  const describeScene = useLibrary((s) => s.describeScene);
  const fileRef = useRef<HTMLInputElement>(null);

  const [config, setConfig] = useState<SceneConfig | null>(null);
  /** Hashes of images currently being described (placeholder cards). */
  const [pending, setPending] = useState<string[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    api.sceneConfig().then(setConfig).catch(() => setConfig({ available: false, model: null }));
  }, []);

  const onPick = async (files: FileList | null) => {
    if (!files?.length) return;
    for (const file of Array.from(files)) {
      let hash: string;
      try {
        ({ hash } = await api.uploadAsset(file));
      } catch (err) {
        toast.error("Upload failed", { description: (err as Error).message });
        continue;
      }
      setPending((p) => [...p, hash]);
      try {
        const scene = await describeScene(hash, file.name.replace(/\.[^.]+$/, ""));
        if (scene.status === SceneStatus.Failed) {
          toast.error("Couldn't describe the scene", { description: scene.error });
        } else {
          setOpenId(scene.id); // jump straight into the editable breakdown
        }
      } catch (err) {
        toast.error("Couldn't describe the scene", { description: (err as Error).message });
      } finally {
        setPending((p) => p.filter((h) => h !== hash));
      }
    }
  };

  const open = scenes.find((s) => s.id === openId) ?? null;
  const available = config?.available ?? true; // optimistic until the probe resolves

  return (
    <PageShell
      title="Scenes"
      subtitle="Describe a reference scene, then recompose it in your own style"
      icon={<Images className="h-4 w-4" />}
      actions={
        <Button
          variant="accent"
          size="sm"
          onClick={() => fileRef.current?.click()}
          disabled={!available}
          title={available ? "Upload a reference scene" : "Vision model unavailable — set FAL_KEY"}
        >
          <UploadCloud className="h-3.5 w-3.5" />
          Add scene
        </Button>
      }
    >
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

      {!available && config && (
        <div className="mb-4 rounded-lg border border-border bg-bg/40 px-3 py-2 text-xs text-faint">
          Scene description needs a vision model. Set <code className="text-muted">FAL_KEY</code> in the
          server env (optionally <code className="text-muted">FAL_VISION_MODEL</code>) and reload.
        </div>
      )}

      {scenes.length === 0 && pending.length === 0 ? (
        <button
          onClick={() => available && fileRef.current?.click()}
          disabled={!available}
          className="flex w-full flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border px-6 py-16 text-center text-muted transition hover:border-accent/60 hover:text-text disabled:opacity-60"
        >
          <UploadCloud className="h-8 w-8" />
          <span className="text-sm font-medium">Add a reference scene</span>
          <span className="max-w-md text-xs text-faint">
            Drop in a frame you love — a vision model breaks it down into subject, setting,
            composition, lighting and palette you can reuse with your own cast and style.
          </span>
        </button>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
          {pending.map((hash) => (
            <div
              key={hash}
              className="relative aspect-square overflow-hidden rounded-lg border border-border bg-bg/40"
            >
              <img src={api.thumbUrl(hash)} alt="" className="h-full w-full object-cover opacity-40" />
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-faint">
                <Loader2 className="h-5 w-5 animate-spin text-accent" />
                <span className="text-[11px]">describing…</span>
              </div>
            </div>
          ))}
          {scenes.map((scene) => (
            <SceneCard key={scene.id} scene={scene} onOpen={() => setOpenId(scene.id)} />
          ))}
        </div>
      )}

      {open && <SceneDetailModal scene={open} onClose={() => setOpenId(null)} />}
    </PageShell>
  );
}

function SceneCard({ scene, onOpen }: { scene: SceneReference; onOpen: () => void }) {
  const failed = scene.status === SceneStatus.Failed;
  return (
    <button
      onClick={onOpen}
      className="group relative aspect-square overflow-hidden rounded-lg border border-border bg-bg/40 text-left transition hover:border-accent/60"
    >
      <img
        src={api.thumbUrl(scene.sourceHash)}
        alt=""
        className="h-full w-full object-cover transition group-hover:scale-[1.02]"
      />
      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent p-2">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-xs font-medium text-white">{scene.name || "Untitled scene"}</span>
          {failed && <Badge tone="down">failed</Badge>}
        </div>
      </div>
    </button>
  );
}
