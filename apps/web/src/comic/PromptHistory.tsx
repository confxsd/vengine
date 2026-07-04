import { useState } from "react";
import { createPortal } from "react-dom";
import { History, RotateCcw } from "lucide-react";
import { useAnchoredMenu } from "@/lib/useAnchoredMenu";
import { cn } from "@/lib/cn";
import type { PromptSnapshot } from "./usePromptHistory";

interface Props {
  /** Prior versions, newest first (see `usePromptHistory`). */
  snapshots: PromptSnapshot[];
  /** The text on screen now — flags the entry that matches it as "current". */
  current: string;
  /** Restore a version's text back into the field. */
  onRestore: (snap: PromptSnapshot) => void;
  className?: string;
}

/** Compact, self-updating-on-open relative time ("just now", "5m ago", "2h ago"). */
function ago(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/**
 * A git-log-style history of a field's earlier prompts. Hidden until there's
 * something to go back to; then a small clock button (badged with the version
 * count) opens a portalled list of prior versions — each a timestamp, a note on
 * what replaced it, and a preview — that you click to restore. Pairs with the AI
 * assist button so nothing you had before an "AI improve" is ever lost.
 */
export function PromptHistory({ snapshots, current, onRestore, className }: Props) {
  const [open, setOpen] = useState(false);
  const { triggerRef, menuRef, coords } = useAnchoredMenu(open, () => setOpen(false));

  // Nothing captured yet — keep the field clean until there's a version to offer.
  if (snapshots.length === 0) return null;

  const restore = (snap: PromptSnapshot) => {
    setOpen(false);
    if (snap.value !== current) onRestore(snap);
  };

  return (
    <div ref={triggerRef} className={cn("flex items-center", className)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Prompt history"
        title={`Prompt history · ${snapshots.length} version${snapshots.length === 1 ? "" : "s"}`}
        className="inline-flex h-6 items-center gap-1 rounded-md bg-elevated/90 px-1.5 text-[10px] font-medium text-muted backdrop-blur transition-colors hover:text-accent"
      >
        <History className="h-3 w-3" />
        <span className="tabular-nums">{snapshots.length}</span>
      </button>

      {open &&
        createPortal(
          <div
            ref={menuRef}
            // Stop the wrapping <label> from stealing focus / forwarding the click.
            onMouseDown={(e) => e.stopPropagation()}
            style={coords ? { top: coords.top, left: coords.left } : undefined}
            className={cn(
              // Portalled to <body> so it escapes the field's stacking context; z
              // high to clear modals and the preview panel.
              "fixed z-[60] flex max-h-[60vh] w-72 flex-col overflow-hidden rounded-md border border-border bg-surface shadow-lg shadow-black/30",
              coords ? "opacity-100" : "pointer-events-none opacity-0",
            )}
          >
            <div className="flex items-center justify-between border-b border-border px-3 py-2">
              <span className="flex items-center gap-1.5 text-[11px] font-semibold text-text">
                <History className="h-3 w-3 text-faint" />
                Prompt history
              </span>
              <span className="tabular-nums text-[10px] text-faint">
                {snapshots.length} version{snapshots.length === 1 ? "" : "s"}
              </span>
            </div>

            <div className="overflow-y-auto py-1">
              {snapshots.map((snap, i) => {
                const isCurrent = snap.value === current;
                return (
                  <button
                    key={snap.id}
                    type="button"
                    disabled={isCurrent}
                    onClick={() => restore(snap)}
                    title={isCurrent ? "This is the current text" : "Restore this version"}
                    className={cn(
                      "group/row flex w-full gap-2 px-3 py-2 text-left transition-colors",
                      isCurrent ? "cursor-default" : "hover:bg-elevated",
                    )}
                  >
                    {/* Git-style rail: a node per version, joined by a line. */}
                    <span className="relative flex w-2 shrink-0 justify-center pt-1">
                      <span
                        className={cn(
                          "z-10 h-2 w-2 rounded-full ring-2 ring-surface",
                          isCurrent ? "bg-accent" : "bg-faint group-hover/row:bg-accent",
                        )}
                      />
                      {i < snapshots.length - 1 && (
                        <span className="absolute left-1/2 top-2 h-full w-px -translate-x-1/2 bg-border" />
                      )}
                    </span>

                    <span className="min-w-0 flex-1">
                      <span className="flex items-center justify-between gap-2">
                        <span className="truncate text-[10px] font-medium text-muted">
                          {snap.note}
                        </span>
                        <span className="flex shrink-0 items-center gap-1">
                          {isCurrent ? (
                            <span className="rounded-sm bg-accent/15 px-1 py-px text-[9px] font-medium text-accent">
                              current
                            </span>
                          ) : (
                            <RotateCcw className="h-3 w-3 text-faint opacity-0 transition-opacity group-hover/row:opacity-100" />
                          )}
                          <span className="tabular-nums text-[10px] text-faint">{ago(snap.at)}</span>
                        </span>
                      </span>
                      <span className="mt-0.5 line-clamp-2 break-words text-[11px] leading-snug text-text/90">
                        {snap.value.trim() || <span className="italic text-faint">(empty)</span>}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
