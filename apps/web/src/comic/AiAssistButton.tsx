import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";
import {
  ASSIST_FIELD_META,
  ASSIST_MODE_META,
  type AssistField,
  type AssistMode,
} from "@vengine/shared";
import { useComic } from "../comicStore";
import { api } from "../api";
import { cn } from "@/lib/cn";

interface Props {
  /** Which field this is — drives the default mode and the seeded server prompt. */
  field: AssistField;
  /** Current text value being revised. */
  value: string;
  /** Called with the AI's revised text. */
  onApply: (text: string) => void;
  /** Field-aware context (story/settings/style/…) — see `buildAssistContext`. */
  context?: Record<string, string>;
  className?: string;
}

/**
 * Inline "AI" control attached to a text input. Clicking runs the field's default
 * action (e.g. enrich); the caret opens the field's other modes (fix grammar,
 * make concise). Hidden entirely when the server has no text model/key.
 */
export function AiAssistButton({ field, value, onApply, context, className }: Props) {
  const available = useComic((s) => s.assistAvailable);
  const [busy, setBusy] = useState<AssistMode | null>(null);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const meta = ASSIST_FIELD_META[field];

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  if (!available) return null;

  const run = async (mode: AssistMode) => {
    setOpen(false);
    if (busy) return;
    setBusy(mode);
    try {
      const res = await api.assist({ field, mode, text: value, context });
      onApply(res.text);
    } catch (err) {
      toast.error("AI assist failed", { description: (err as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const single = meta.modes.length === 1;
  const def = ASSIST_MODE_META[meta.defaultMode];

  return (
    <div
      ref={ref}
      // Stop the wrapping <label> from stealing focus / forwarding the click.
      onMouseDown={(e) => e.stopPropagation()}
      className={cn("absolute bottom-1.5 right-1.5 z-10 flex items-center", className)}
    >
      <button
        type="button"
        disabled={!!busy}
        onClick={() => run(meta.defaultMode)}
        title={`AI · ${def.label}: ${def.hint}`}
        className={cn(
          "inline-flex h-6 items-center gap-1 bg-elevated/90 px-1.5 text-[10px] font-medium text-muted backdrop-blur transition-colors hover:text-accent disabled:opacity-50",
          single ? "rounded-md" : "rounded-l-md",
        )}
      >
        {busy ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <Sparkles className="h-3 w-3" />
        )}
        AI
      </button>
      {!single && (
        <button
          type="button"
          disabled={!!busy}
          onClick={() => setOpen((o) => !o)}
          aria-label="More AI actions"
          title="More AI actions"
          className="inline-flex h-6 items-center rounded-r-md border-l border-border bg-elevated/90 px-0.5 text-muted backdrop-blur transition-colors hover:text-accent disabled:opacity-50"
        >
          <ChevronDown className="h-3 w-3" />
        </button>
      )}
      {open && (
        <div className="absolute bottom-7 right-0 z-20 min-w-44 overflow-hidden rounded-md border border-border bg-surface shadow-lg shadow-black/30">
          {meta.modes.map((m) => {
            const mm = ASSIST_MODE_META[m];
            return (
              <button
                key={m}
                type="button"
                onClick={() => run(m)}
                className="flex w-full flex-col items-start gap-0.5 px-2.5 py-1.5 text-left transition-colors hover:bg-elevated"
              >
                <span className="flex items-center gap-1.5 text-[11px] font-medium text-text">
                  {m === meta.defaultMode ? (
                    <Check className="h-3 w-3 text-accent" />
                  ) : (
                    <span className="w-3" />
                  )}
                  {mm.label}
                </span>
                <span className="pl-[18px] text-[10px] leading-tight text-faint">{mm.hint}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
