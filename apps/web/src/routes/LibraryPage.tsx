import { useState } from "react";
import { Library as LibraryIcon } from "lucide-react";
import { Segmented } from "../components/ui";
import { CharactersTab, StylesTab, ModelsTab } from "../comic/LibraryPanel";
import { PageShell } from "./PageShell";

type Section = "characters" | "styles" | "models";
const SECTIONS = [
  { value: "characters" as const, label: "Characters" },
  { value: "styles" as const, label: "Styles" },
  { value: "models" as const, label: "Models" },
];

/**
 * The Library as a full page — the same durable assets the slide-over manages
 * (characters, style packs, trained LoRAs), just with room to breathe. The slide-over
 * stays the in-context way to *apply* assets to a comic; this page is the place to
 * *curate* them. Both render the same tab components, so they never drift.
 */
export default function LibraryPage() {
  const [section, setSection] = useState<Section>("characters");
  return (
    <PageShell
      title="Library"
      subtitle="Characters, style packs & trained models — shared across every project"
      icon={<LibraryIcon className="h-4 w-4" />}
      actions={
        <Segmented
          aria-label="Library section"
          value={section}
          onChange={setSection}
          options={SECTIONS}
          size="sm"
        />
      }
    >
      <div className="mx-auto max-w-2xl">
        {section === "characters" && <CharactersTab />}
        {section === "styles" && <StylesTab />}
        {section === "models" && <ModelsTab />}
      </div>
    </PageShell>
  );
}
