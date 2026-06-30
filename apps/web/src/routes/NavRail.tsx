import { NavLink } from "react-router-dom";
import {
  BookOpen,
  Film,
  Images,
  Library as LibraryIcon,
  Settings,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { TrainingStatus } from "@vengine/shared";
import { useLibrary } from "../libraryStore";
import { cn } from "@/lib/cn";

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Match only the exact path (the index route), not descendants. */
  end?: boolean;
}

const ITEMS: NavItem[] = [
  { to: "/", label: "Studio", icon: Film, end: true },
  { to: "/canvas", label: "Canvas", icon: Workflow },
  { to: "/library", label: "Library", icon: LibraryIcon },
  { to: "/scenes", label: "Scenes", icon: Images },
  { to: "/series", label: "Series", icon: BookOpen },
];

/**
 * The persistent left icon rail — the studio's primary navigation (destinations),
 * complementary to the in-context Library slide-over (ingredients). A narrow,
 * always-present column so switching surfaces never unmounts the global overlays.
 */
export function NavRail() {
  // A subtle pulse on the Library tab while any LoRA is training in the background.
  const training = useLibrary((s) =>
    s.library.trainedLoras.some((t) => t.status === TrainingStatus.Training),
  );

  return (
    <nav className="flex w-14 shrink-0 flex-col items-center gap-1 border-r border-border bg-surface py-3">
      <div className="mb-2 h-6 w-6 rounded-md bg-gradient-to-br from-accent to-purple" title="vengine" />

      {ITEMS.map((item) => (
        <RailLink key={item.to} item={item} badge={item.to === "/library" && training} />
      ))}

      <div className="flex-1" />

      <RailLink item={{ to: "/settings", label: "Settings", icon: Settings }} />
    </nav>
  );
}

function RailLink({ item, badge }: { item: NavItem; badge?: boolean }) {
  const Icon = item.icon;
  return (
    <NavLink
      to={item.to}
      end={item.end}
      title={item.label}
      className={({ isActive }) =>
        cn(
          "relative flex h-10 w-10 items-center justify-center rounded-lg transition",
          isActive
            ? "bg-accent/15 text-accent"
            : "text-faint hover:bg-bg/60 hover:text-text",
        )
      }
    >
      <Icon className="h-[18px] w-[18px]" />
      {badge && (
        <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
      )}
    </NavLink>
  );
}
