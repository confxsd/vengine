import { useEffect, useState } from "react";
import { CheckCircle2, Settings, XCircle } from "lucide-react";
import { api } from "../api";
import { PageShell } from "./PageShell";
import type { SceneConfig } from "../types";

/** A capability + the env that powers it. Availability comes from a server probe so
 *  the UI reflects what's *actually* usable (key present), not just what's coded. */
interface Capability {
  name: string;
  description: string;
  env: string;
  config: SceneConfig | null;
}

/**
 * Settings — at a glance, which provider-backed capabilities are live. Keys are
 * resolved server-side from the environment (never entered in the browser), so this
 * page is read-only status plus the env names to set. It probes the same endpoints
 * the feature UIs use, so "available" here means the feature will actually work.
 */
export default function SettingsPage() {
  const [assist, setAssist] = useState<SceneConfig | null>(null);
  const [scenes, setScenes] = useState<SceneConfig | null>(null);

  useEffect(() => {
    api.assistConfig().then(setAssist).catch(() => setAssist({ available: false, model: null }));
    api.sceneConfig().then(setScenes).catch(() => setScenes({ available: false, model: null }));
  }, []);

  const capabilities: Capability[] = [
    {
      name: "AI text assist",
      description: "Polish, enrich and fix prompt/prose fields in the studio.",
      env: "DEEPSEEK_KEY",
      config: assist,
    },
    {
      name: "Scene understanding",
      description: "Describe a reference image into a reusable breakdown (Scenes).",
      env: "FAL_VISION_MODEL · FAL_KEY",
      config: scenes,
    },
  ];

  return (
    <PageShell title="Settings" subtitle="Provider availability & environment" icon={<Settings className="h-4 w-4" />}>
      <div className="flex flex-col gap-6">
        <section className="flex flex-col gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-faint">Capabilities</h2>
          {capabilities.map((cap) => (
            <CapabilityRow key={cap.name} cap={cap} />
          ))}
        </section>

        <section className="flex flex-col gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-faint">Environment keys</h2>
          <div className="rounded-lg border border-border bg-bg/40 p-4 text-xs text-muted">
            <p>
              API keys are read from the <strong>server environment only</strong> (a <code>.env</code> at
              the repo root) and are never sent to or entered in the browser.
            </p>
            <ul className="mt-2 space-y-1 text-faint">
              <li>
                <code className="text-muted">FAL_KEY</code> — image generation, LoRA training & scene
                vision (fal.ai)
              </li>
              <li>
                <code className="text-muted">FAL_VISION_MODEL</code> — optional override for the scene
                vision model
              </li>
              <li>
                <code className="text-muted">DEEPSEEK_KEY</code> — AI text assist (DeepSeek)
              </li>
            </ul>
          </div>
        </section>
      </div>
    </PageShell>
  );
}

function CapabilityRow({ cap }: { cap: Capability }) {
  const loading = cap.config === null;
  const available = cap.config?.available ?? false;
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-bg/40 p-3">
      <div className="mt-0.5">
        {loading ? (
          <span className="block h-4 w-4 animate-pulse rounded-full bg-border" />
        ) : available ? (
          <CheckCircle2 className="h-4 w-4 text-up" />
        ) : (
          <XCircle className="h-4 w-4 text-faint" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm text-text">{cap.name}</span>
          {available && cap.config?.model && (
            <span className="truncate text-[11px] text-faint">· {cap.config.model}</span>
          )}
        </div>
        <p className="text-[11px] text-faint">{cap.description}</p>
      </div>
      <code className="shrink-0 text-[10px] text-faint">{cap.env}</code>
    </div>
  );
}
