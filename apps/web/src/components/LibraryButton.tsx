import { Library as LibraryIcon } from "lucide-react";
import { TrainingStatus } from "@vengine/shared";
import { useLibrary } from "../libraryStore";
import { Button } from "./ui";

/**
 * Opens the cross-project Library slide-over. Lives in both the Storyboard header
 * and the Canvas toolbar so the Library is reachable from either mode without
 * navigating away — it's an ingredient panel, not a destination.
 */
export function LibraryButton() {
  const toggle = useLibrary((s) => s.toggle);
  const open = useLibrary((s) => s.open);
  const training = useLibrary((s) =>
    s.library.trainedLoras.some((t) => t.status === TrainingStatus.Training),
  );
  return (
    <Button
      variant={open ? "secondary" : "outline"}
      size="sm"
      onClick={toggle}
      title="Library — characters, styles & trained models (⇧L)"
    >
      <LibraryIcon className="h-3.5 w-3.5" />
      Library
      {training && <span className="ml-0.5 h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />}
    </Button>
  );
}
