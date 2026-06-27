import { forwardRef } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";

const fieldBase =
  "w-full bg-elevated/60 text-text placeholder:text-faint rounded-md border border-transparent transition-colors outline-none focus:border-accent focus:bg-bg";

export const Input = forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, type = "text", ...props }, ref) => (
  <input
    ref={ref}
    type={type}
    className={cn(fieldBase, "flex h-8 px-2 text-xs", className)}
    {...props}
  />
));
Input.displayName = "Input";

export const Select = forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(({ className, ...props }, ref) => (
  <select
    ref={ref}
    className={cn(fieldBase, "h-8 px-2 text-xs", className)}
    {...props}
  />
));
Select.displayName = "Select";

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn(fieldBase, "block resize-none p-2 text-xs", className)}
    {...props}
  />
));
Textarea.displayName = "Textarea";

interface ClearInputButtonProps {
  onClick: () => void;
  className?: string;
  "aria-label"?: string;
}

/** Small "×" overlay for clearable inputs — place inside a relative wrapper. */
export function ClearInputButton({
  onClick,
  className,
  "aria-label": ariaLabel = "Clear",
}: ClearInputButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      className={cn(
        "absolute right-1 top-1/2 inline-flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-faint hover:bg-elevated hover:text-text",
        className,
      )}
    >
      <X className="h-3.5 w-3.5" />
    </button>
  );
}

/** A labelled field wrapper — stacked label above any control. */
export function Field({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={cn("flex flex-col gap-1", className)}>
      <span className="eyebrow">{label}</span>
      {children}
    </label>
  );
}
