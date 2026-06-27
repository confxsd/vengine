import { useAppMode, type AppMode } from "../appMode";
import { Segmented } from "./ui";

const MODES: { value: AppMode; label: string }[] = [
  { value: "storyboard", label: "Storyboard" },
  { value: "canvas", label: "Canvas" },
];

/** Switch between the comic storyboard and the raw node canvas. */
export function ModeToggle() {
  const { mode, setMode } = useAppMode();
  return (
    <Segmented
      aria-label="Workspace mode"
      value={mode}
      onChange={setMode}
      options={MODES}
      size="sm"
    />
  );
}
