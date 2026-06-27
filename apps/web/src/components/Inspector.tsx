import { useStudio } from "../store";
import { Field, Input, Select, Textarea } from "./ui";

interface FieldDef {
  key: string;
  label: string;
  kind: "text" | "textarea" | "number" | "select";
  options?: { value: string; label: string }[];
}

const FIELDS: Record<string, FieldDef[]> = {
  "generate.text-to-image": [
    { key: "model", label: "Model", kind: "select" },
    { key: "prompt", label: "Prompt", kind: "textarea" },
    { key: "width", label: "Width", kind: "number" },
    { key: "height", label: "Height", kind: "number" },
    { key: "seed", label: "Seed", kind: "number" },
  ],
  "compositing.resize": [
    { key: "width", label: "Width", kind: "number" },
    { key: "height", label: "Height", kind: "number" },
    {
      key: "fit",
      label: "Fit",
      kind: "select",
      options: ["cover", "contain", "fill", "inside", "outside"].map((v) => ({ value: v, label: v })),
    },
  ],
  "io.export": [
    { key: "dir", label: "Output dir", kind: "text" },
    { key: "filename", label: "Filename", kind: "text" },
    {
      key: "format",
      label: "Format",
      kind: "select",
      options: ["png", "jpeg", "webp"].map((v) => ({ value: v, label: v })),
    },
  ],
  "io.load-image": [{ key: "path", label: "File path", kind: "text" }],
};

export function Inspector() {
  const { nodes, selectedId, updateParams, models } = useStudio();
  const node = nodes.find((n) => n.id === selectedId);

  if (!node) {
    return (
      <div className="p-4 text-sm text-faint">
        Select a node to edit its parameters.
      </div>
    );
  }

  const fields = FIELDS[node.data.type] ?? [];
  const params = node.data.params;

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex flex-col gap-0.5">
        <span className="eyebrow">{node.data.category}</span>
        <div className="text-sm font-semibold text-text">{node.data.title}</div>
        <div className="font-mono text-[10px] text-faint">{node.id}</div>
      </div>

      <div className="hairline" />

      {fields.map((f) => {
        const value = params[f.key] ?? "";
        const options =
          f.key === "model"
            ? models.map((m) => ({ value: m.id, label: m.displayName }))
            : f.options;
        return (
          <Field key={f.key} label={f.label}>
            {f.kind === "textarea" ? (
              <Textarea
                className="h-20"
                value={String(value)}
                onChange={(e) => updateParams(node.id, { [f.key]: e.target.value })}
              />
            ) : f.kind === "select" ? (
              <Select
                value={String(value)}
                onChange={(e) => updateParams(node.id, { [f.key]: e.target.value })}
              >
                {(options ?? []).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            ) : (
              <Input
                type={f.kind === "number" ? "number" : "text"}
                value={String(value)}
                onChange={(e) =>
                  updateParams(node.id, {
                    [f.key]: f.kind === "number" ? Number(e.target.value) : e.target.value,
                  })
                }
              />
            )}
          </Field>
        );
      })}
    </div>
  );
}
