import { useEffect, useRef, useState } from "react";
import { Clapperboard, Loader2, Send, X } from "lucide-react";
import type { DirectorMessage } from "@vengine/shared";
import { useComic } from "../comicStore";
import { useLibrary } from "../libraryStore";
import { api } from "../api";
import { Button, Textarea } from "../components/ui";
import { cn } from "@/lib/cn";

/**
 * The director chat — a drawer beside the frame grid. The author discusses the
 * episode like a director (theme, subtext, mood, character intent); each turn is
 * answered with a discussion AND structured edits the server auto-applies (after
 * snapshotting, so a turn is undoable from the snapshot list). After every turn the
 * project and library are re-adopted server-side so the frames update in place.
 */
export function DirectorPanel({ onClose }: { onClose: () => void }) {
  const project = useComic((s) => s.project);
  const adoptServerProject = useComic((s) => s.adoptServerProject);
  const refetchLibrary = useLibrary((s) => s.refetch);
  const [messages, setMessages] = useState<DirectorMessage[]>(project?.director ?? []);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Resync the local transcript when the project changes identity (switch/reload).
  useEffect(() => {
    setMessages(project?.director ?? []);
  }, [project?.id, project?.director]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, busy]);

  if (!project) return null;

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setError(null);
    setBusy(true);
    // Optimistic user bubble; replaced by the server-persisted history on success.
    setMessages((m) => [
      ...m,
      { role: "user", text, changes: [], log: [], at: new Date().toISOString() },
    ]);
    try {
      const result = await api.directorSay(project.id, text);
      // Adopt the server-authoritative project (frames/story/cast/history) and
      // refresh the library — the director may have touched canon characters.
      adoptServerProject(result.project);
      setMessages(result.project.director ?? []);
      if (result.log.length) void refetchLibrary();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="flex w-96 shrink-0 flex-col border-l border-border bg-surface">
      <header className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <Clapperboard className="h-4 w-4 text-accent" />
        <span className="text-sm font-semibold text-text">Director</span>
        <span className="text-[10px] text-faint">
          discuss it — edits land automatically (snapshot per turn)
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close director chat"
          className="ml-auto text-faint transition-colors hover:text-text"
        >
          <X className="h-4 w-4" />
        </button>
      </header>

      <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
        {messages.length === 0 && (
          <div className="rounded-lg border border-dashed border-border p-3 text-[11px] leading-relaxed text-faint">
            Talk to your story like a director. Discuss theme, mood, what a character
            is really feeling — the director rewrites the affected frames, characters
            and settings to match.
            <div className="mt-2 text-faint/80">
              e.g. “frame 3's Bruce should read wounded, not contemptuous — he's
              withdrawing because he's terrified, not judging her” or “the whole
              episode is melancholic; the last frame turns quietly liberated”.
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          <div
            key={i}
            className={cn(
              "max-w-[92%] rounded-lg px-3 py-2 text-[12px] leading-relaxed",
              m.role === "user"
                ? "self-end bg-accent-soft text-text"
                : "self-start border border-border bg-elevated/50 text-muted",
            )}
          >
            <p className="whitespace-pre-wrap">{m.text}</p>
            {m.log.length > 0 && (
              <ul className="mt-2 space-y-1 border-t border-border/70 pt-1.5 font-mono text-[10px] text-accent/90">
                {m.log.map((line, j) => (
                  <li key={j}>· {line}</li>
                ))}
              </ul>
            )}
          </div>
        ))}
        {busy && (
          <div className="flex items-center gap-2 self-start rounded-lg border border-border bg-elevated/50 px-3 py-2 text-[11px] text-faint">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            thinking · applying edits…
          </div>
        )}
        {error && (
          <p className="self-center rounded-md bg-down/10 px-2.5 py-1.5 text-[11px] text-down ring-1 ring-down/30">
            {error}
          </p>
        )}
      </div>

      <div className="border-t border-border p-3">
        <div className="flex items-end gap-2">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder="Direct the story… (Enter to send)"
            className="min-h-16 resize-y text-[12px]"
            disabled={busy}
          />
          <Button variant="accent" size="lg" onClick={() => void send()} disabled={busy || !input.trim()}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
          </Button>
        </div>
      </div>
    </aside>
  );
}
