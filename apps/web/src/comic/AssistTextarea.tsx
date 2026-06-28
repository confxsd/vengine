import { forwardRef, useState } from "react";
import { Maximize2 } from "lucide-react";
import type { AssistField } from "@vengine/shared";
import { Textarea } from "../components/ui";
import { AiAssistButton } from "./AiAssistButton";
import { FocusedEditor } from "./FocusedEditor";
import { cn } from "@/lib/cn";

type TextareaProps = Omit<
  React.TextareaHTMLAttributes<HTMLTextAreaElement>,
  "value" | "onChange"
>;

interface Props extends TextareaProps {
  /** Which field this is — drives the AI button's behavior and seeded prompt. */
  field: AssistField;
  value: string;
  /** Receives both manual edits and AI-applied revisions. */
  onValueChange: (value: string) => void;
  /** Field-aware context passed to the AI (see `buildAssistContext`). */
  context?: Record<string, string>;
  /**
   * Grow with content (up to a max, then scroll) instead of a fixed height.
   * Uses native CSS `field-sizing`; falls back to the min height elsewhere.
   */
  autoGrow?: boolean;
  /** Show an expand control that opens a roomy focused editor overlay. */
  expandable?: boolean;
  /** Title shown in the focused editor's header (defaults to the placeholder). */
  editorTitle?: string;
}

/**
 * A `Textarea` with an inline AI assist button. The single integration point for
 * adding AI text help to a field — callers just swap `onChange`/`value` for
 * `onValueChange`/`value`. Reserves bottom padding so text never sits under the
 * button. Optionally grows with content and offers an "expand" control that opens
 * a focused, full-size editor overlay for comfortable long-form writing.
 */
export const AssistTextarea = forwardRef<HTMLTextAreaElement, Props>(
  (
    {
      field,
      value,
      onValueChange,
      context,
      className,
      autoGrow,
      expandable,
      editorTitle,
      placeholder,
      ...rest
    },
    ref,
  ) => {
    const [expanded, setExpanded] = useState(false);

    return (
      <div className="group/assist relative">
        <Textarea
          ref={ref}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onValueChange(e.target.value)}
          className={cn(
            "pb-8",
            autoGrow && "max-h-64 min-h-20 overflow-y-auto [field-sizing:content]",
            expandable && "pr-9",
            className,
          )}
          {...rest}
        />

        {expandable && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            aria-label="Expand editor"
            title="Expand to focused editor"
            // Stop the wrapping <label> from stealing focus / forwarding the click.
            onMouseDown={(e) => e.stopPropagation()}
            className="absolute right-1.5 top-1.5 z-10 rounded bg-elevated/80 p-1 text-faint opacity-0 backdrop-blur transition hover:text-accent focus-visible:opacity-100 group-focus-within/assist:opacity-100 group-hover/assist:opacity-100"
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </button>
        )}

        <AiAssistButton field={field} value={value} onApply={onValueChange} context={context} />

        {expanded && (
          <FocusedEditor
            title={editorTitle ?? placeholder ?? "Edit text"}
            field={field}
            value={value}
            placeholder={placeholder}
            onValueChange={onValueChange}
            context={context}
            onClose={() => setExpanded(false)}
          />
        )}
      </div>
    );
  },
);
AssistTextarea.displayName = "AssistTextarea";
