import type { ReactNode } from "react";

/**
 * Consistent chrome for a full-page route (Library / Scenes / Series / Settings):
 * a sticky title bar with optional actions over a scrollable, max-width body. The
 * storyboard and canvas keep their own bespoke headers — this is only for the new
 * management pages so they share one look.
 */
export function PageShell({
  title,
  subtitle,
  icon,
  actions,
  children,
}: {
  title: string;
  subtitle?: string;
  icon?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-border bg-surface/80 px-6 py-3 backdrop-blur">
        {icon && <div className="text-accent">{icon}</div>}
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold text-text">{title}</h1>
          {subtitle && <p className="truncate text-[11px] text-faint">{subtitle}</p>}
        </div>
        <div className="flex-1" />
        {actions}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl px-6 py-6">{children}</div>
      </div>
    </div>
  );
}
