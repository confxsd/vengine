import { useEffect, useState } from "react";
import { Input, Textarea } from "./ui";

/**
 * Inputs that **resync to the source value while not focused**. Library/scene records
 * are server-owned and can change under the field (a WS-driven refetch, a value the
 * server normalized) — an uncontrolled `defaultValue` would silently keep showing the
 * stale text and a blur could then save the stale value back. These hold local edits
 * while focused and adopt the prop otherwise, committing on blur only when changed.
 */
export function SyncedInput({
  value,
  onCommit,
  className,
  placeholder,
}: {
  value: string;
  onCommit: (v: string) => void;
  className?: string;
  placeholder?: string;
}) {
  const [local, setLocal] = useState(value);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setLocal(value);
  }, [value, focused]);
  return (
    <Input
      className={className}
      placeholder={placeholder}
      value={local}
      onChange={(e) => setLocal(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        if (local !== value) onCommit(local);
      }}
    />
  );
}

export function SyncedTextarea({
  value,
  onCommit,
  className,
  placeholder,
}: {
  value: string;
  onCommit: (v: string) => void;
  className?: string;
  placeholder?: string;
}) {
  const [local, setLocal] = useState(value);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setLocal(value);
  }, [value, focused]);
  return (
    <Textarea
      className={className}
      placeholder={placeholder}
      value={local}
      onChange={(e) => setLocal(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        if (local !== value) onCommit(local);
      }}
    />
  );
}
