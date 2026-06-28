import { useEffect, useRef } from "react";
import { Minimize2 } from "lucide-react";
import type { AssistField } from "@vengine/shared";
import { AiAssistButton } from "./AiAssistButton";

interface Props {
  /** Heading shown in the editor's title bar. */
  title: string;
  /** Drives the AI assist button's behavior and seeded prompt. */
  field: AssistField;
  value: string;
  placeholder?: string;
  onValueChange: (value: string) => void;
  context?: Record<string, string>;
  /** Collapse back to the inline field. */
  onClose: () => void;
}

/**
 * A roomy, focused overlay for writing a single long text field "like an editor".
 * Edits flow straight through `onValueChange` (live — there is no separate save),
 * so collapsing simply dismisses the overlay. Esc or ⌘/Ctrl+↵ collapses it.
 */
export function FocusedEditor({
  title,
  field,
  value,
  placeholder,
  onValueChange,
  context,
  onClose,
}: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);

  // Focus and drop the caret at the end so you continue where you left off.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isSubmit = (e.metaKey || e.ctrlKey) && e.key === "Enter";
      if (e.key === "Escape" || isSubmit) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const trimmed = value.trim();
  const words = trimmed ? trimmed.split(/\s+/).length : 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm"
      onMouseDown={onClose}
    >
      <div
        className="flex w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-2xl shadow-black/40"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
          <span className="truncate text-sm font-semibold text-text">{title}</span>
          <div className="flex shrink-0 items-center gap-3">
            <span className="tabular-nums text-[11px] text-faint">
              {value.length} chars · {words} words
            </span>
            <button
              type="button"
              onClick={onClose}
              aria-label="Collapse editor"
              title="Collapse (Esc)"
              className="text-faint transition-colors hover:text-text"
            >
              <Minimize2 className="h-4 w-4" />
            </button>
          </div>
        </header>

        <div className="relative p-3">
          <textarea
            ref={ref}
            value={value}
            placeholder={placeholder}
            onChange={(e) => onValueChange(e.target.value)}
            className="block h-[55vh] w-full resize-none rounded-lg bg-bg p-4 pb-12 text-sm leading-relaxed text-text outline-none ring-1 ring-border transition-colors placeholder:text-faint focus:ring-accent"
          />
          <AiAssistButton
            field={field}
            value={value}
            onApply={onValueChange}
            context={context}
            className="bottom-6 right-6"
          />
        </div>

        <footer className="flex items-center justify-end border-t border-border px-4 py-2 text-[11px] text-faint">
          <span className="flex items-center gap-1.5">
            <kbd className="rounded border border-border bg-elevated px-1.5 py-0.5 font-sans text-[10px]">
              Esc
            </kbd>
            <span>or</span>
            <kbd className="rounded border border-border bg-elevated px-1.5 py-0.5 font-sans text-[10px]">
              ⌘↵
            </kbd>
            <span>to collapse</span>
          </span>
        </footer>
      </div>
    </div>
  );
}
