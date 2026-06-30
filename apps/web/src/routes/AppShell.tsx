import { Suspense } from "react";
import { Outlet } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { NavRail } from "./NavRail";
import { LibraryPanel } from "../comic/LibraryPanel";
import { Lightbox } from "../components/Lightbox";
import { Toaster } from "../components/ui";

/** Centered fallback while a lazily-loaded route page resolves. */
function PageLoading() {
  return (
    <div className="flex h-full items-center justify-center text-faint">
      <Loader2 className="h-5 w-5 animate-spin" />
    </div>
  );
}

/**
 * The studio frame shared by every route: the persistent nav rail on the left, the
 * active page in the center (lazy pages stream in behind a Suspense fallback), and
 * the global overlays (Library slide-over, Lightbox, toasts) mounted once so they
 * survive navigation between pages.
 */
export function AppShell() {
  return (
    <div className="flex h-full bg-bg text-text">
      <NavRail />
      <div className="min-w-0 flex-1">
        <Suspense fallback={<PageLoading />}>
          <Outlet />
        </Suspense>
      </div>
      <LibraryPanel />
      <Lightbox />
      <Toaster />
    </div>
  );
}
