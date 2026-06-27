import { Calculator, Play, Plus, RotateCcw } from "lucide-react";
import { useStudio } from "../store";
import { ModeToggle } from "./ModeToggle";
import { Button, Segmented, Select, ThemeToggle } from "./ui";

const QUALITY = [
  { value: "preview", label: "Preview" },
  { value: "final", label: "Final" },
] as const;

export function Toolbar() {
  const {
    quality,
    setQuality,
    doRun,
    doPlan,
    running,
    status,
    plan,
    manifest,
    addNode,
    resetWorkspace,
  } = useStudio();

  return (
    <header className="flex items-center gap-3 border-b border-border bg-surface/80 px-4 py-2.5 backdrop-blur">
      <div className="flex items-center gap-2">
        <div className="h-5 w-5 rounded-md bg-gradient-to-br from-accent to-purple" />
        <span className="text-sm font-semibold tracking-tight text-text">
          vengine
        </span>
      </div>
      <ModeToggle />

      <div className="mx-1 h-5 w-px bg-border" />

      {/* Add node */}
      <Select
        className="w-36"
        value=""
        onChange={(e) => {
          if (e.target.value) addNode(e.target.value);
          e.target.value = "";
        }}
      >
        <option value="">+ Add node…</option>
        {manifest.map((m) => (
          <option key={m.type} value={m.type}>
            {m.title}
          </option>
        ))}
      </Select>

      <Segmented
        aria-label="Render quality"
        value={quality}
        onChange={setQuality}
        options={QUALITY}
        size="sm"
      />

      <Button variant="secondary" size="sm" onClick={doPlan}>
        <Calculator className="h-3.5 w-3.5" />
        Estimate
      </Button>

      {plan && (
        <span className="font-mono text-xs text-muted">
          ~${plan.estTotalCost.toFixed(4)}{" "}
          <span className="text-faint">
            ({plan.willRunCount} run · {plan.cachedCount} cached)
          </span>
        </span>
      )}

      <Button
        variant="ghost"
        size="sm"
        className="text-faint hover:text-down"
        onClick={() => {
          if (
            confirm(
              "Reset the workspace to a fresh demo graph? Your current canvas will be cleared.",
            )
          ) {
            resetWorkspace();
          }
        }}
      >
        <RotateCcw className="h-3.5 w-3.5" />
        Reset
      </Button>

      <div className="flex-1" />

      <span className="font-mono text-xs text-faint">{status}</span>
      <span className="font-mono text-[10px] text-faint/70">· autosaved</span>

      <ThemeToggle />

      <Button variant="accent" size="lg" onClick={doRun} disabled={running}>
        <Play className="h-3.5 w-3.5 fill-current" />
        {running ? "Running…" : "Run"}
      </Button>
    </header>
  );
}
