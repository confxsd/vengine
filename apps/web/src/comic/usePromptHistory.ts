import { useCallback, useRef, useState } from "react";

export interface PromptSnapshot {
  id: string;
  /** The text exactly as it was — restore drops it straight back in. */
  value: string;
  /** When it was captured (epoch ms), for the relative timestamp. */
  at: number;
  /** Why it was saved, e.g. "Before enrich" / "Before restore". */
  note: string;
}

/** Keep a generous but bounded trail; old versions fall off the end. */
const MAX_SNAPSHOTS = 30;

/**
 * A lightweight, git-like history of a single text field's prior values.
 *
 * Nothing is recorded on every keystroke — a snapshot is taken only at the moments
 * a value is about to be *replaced wholesale* (an AI revision applies, or a restore
 * overwrites the working copy). So every entry is a meaningful "prompt you had
 * before", the exact thing lost today when AI improve overwrites the field. Newest
 * first, capped, and session-scoped (lives as long as the field is mounted).
 */
export function usePromptHistory() {
  const [snapshots, setSnapshots] = useState<PromptSnapshot[]>([]);
  const seq = useRef(0);

  const capture = useCallback((value: string, note: string) => {
    // An empty/whitespace field is not a version worth going back to.
    if (!value.trim()) return;
    setSnapshots((prev) => {
      // Don't stack identical consecutive versions (e.g. AI returned the same text).
      if (prev[0]?.value === value) return prev;
      const entry: PromptSnapshot = { id: `h${seq.current++}`, value, at: Date.now(), note };
      return [entry, ...prev].slice(0, MAX_SNAPSHOTS);
    });
  }, []);

  const clear = useCallback(() => setSnapshots([]), []);

  return { snapshots, capture, clear };
}
