# Visual Studio — Roadmap

vengine is growing from a single-surface comic tool into a **multi-page visual studio** for
character-consistent, long-running series across arbitrary art styles. This document is the
architectural north star: what the studio is, the data model, the page layout, and the phased
build.

The guiding constraint is **zero disruption to the working surface**. The storyboard
(`ComicStudio`) stays exactly where it is — at `/` — and keeps doing the practical day-to-day
work. Everything new is additive: real routes, richer configuration pages, and new
intelligence features layered around the same content-addressed asset store and cross-project
library that already exist.

## Three independent axes (unchanged mental model)

Generation is the composition of three orthogonal things. The studio's pages map onto them:

| Axis            | Owns                                              | Page          |
| --------------- | ------------------------------------------------- | ------------- |
| **Identity**    | recurring cast → `refHashes` / character LoRA     | Library       |
| **Style**       | medium / palette / negative → Style Pack / LoRA   | Library       |
| **Composition** | the concrete scene: subject, action, camera       | Studio, Scenes |

"Series" is the fourth, cross-cutting concept: a durable grouping of projects that share a
cast + default style for continuity across many chapters.

## Pages

A persistent left **icon rail** (VS Code / Figma style) hosts navigation. The slide-over
Library stays mounted globally so assets are always reachable *in-context* without leaving the
current page — the rail is for destinations, the slide-over is for ingredients.

- **`/` — Studio** — the comic storyboard. The practical working surface, unchanged.
- **`/canvas` — Canvas** — the raw node graph.
- **`/library` — Library** — full-page management of Characters, Styles, Models (the slide-over
  content promoted to a real, roomier page).
- **`/library/characters/:id` — Character** — one character in depth: reference gallery, sheet
  import, LoRA training, description, palette, notes.
- **`/scenes` — Scenes** — _new._ Upload a sample scene image → a vision model writes a
  structured description (subject / setting / composition / palette / mood) → save it → reuse
  it as a prompt seed to regenerate in *your* style with *your* cast.
- **`/series` — Series** — group projects into a series with a shared cast + default style for
  long-form continuity.
- **`/settings` — Settings** — key availability (which providers are live), defaults.

## New capability: Scene understanding (Scenes)

The missing primitive is **image → text**. Today the engine only goes text/refs → image. A
`VisionAdapter` (sibling to `ModelAdapter` / `TextAdapter` / `TrainingAdapter`) closes the
loop:

```
image bytes ─▶ VisionAdapter.describe ─▶ SceneBreakdown ─▶ stored SceneReference
                                                              │
                            "Send to Studio" ◀────────────────┘
                            (seed a frame prompt; apply your style + cast)
```

- **Provider:** routed through **fal** (`fal-ai/any-llm/vision`) so every model call stays
  behind one key, consistent with the image/LoRA stack. Model is env-overridable
  (`FAL_VISION_MODEL`).
- **Storage:** `SceneReference` lives in the same `library.json` document (one mutex, one
  atomic writer) — maximum reuse, no new persistence infra.
- **Human-in-the-loop:** the generated breakdown is fully editable before it's used, the same
  philosophy as the character-sheet review grid.

## Data model (additions only)

All additive to the existing `Library` document — existing consumers are untouched.

```ts
Library {
  characters: LibraryCharacter[]   // existing
  styles:     StylePack[]          // existing
  trainedLoras: TrainedLora[]      // existing
  scenes:     SceneReference[]     // NEW
  series:     Series[]             // NEW
}

SceneReference {
  id, name, sourceHash,
  status: "describing" | "ready" | "failed",
  description?: SceneBreakdown,    // editable
  tags: string[], error?, timestamps
}
SceneBreakdown { caption, subjects[], setting, composition, lighting, palette[], mood, styleNotes }

Series { id, name, description, projectIds[], castIds[], defaultStyleId?, timestamps }
```

## Layout (where code lives)

```
packages/shared/src/scene.ts          SceneReference / SceneBreakdown / Series + zod
packages/providers/src/vision/        VisionAdapter, registry, fal-vision adapter
packages/storage/src/library-store.ts +scene/series CRUD (same mutex + atomic writer)
apps/server/src/scenes.ts             describe / patch / delete + availability probe
apps/web/src/routes/                  AppShell, NavRail, route pages
apps/web/src/sceneStore.ts            (scenes fold into the existing library store/load)
```

## Engineering principles

- **Reuse over new infra** — scenes/series ride the existing library document, mutex, atomic
  writer, asset store, and WS refetch. No second database.
- **Provider-agnostic adapters** — vision is one more adapter behind one registry; swapping the
  underlying VLM is a config change.
- **Additive & backward-compatible** — every schema field is optional or defaulted; the
  storyboard and canvas behave identically.
- **Config-driven, not control-flow-driven** — prompts and field maps are data (mirrors the
  assist routes), so adding a field/mode is one entry.
- **Lazy-loaded routes** — pages are code-split; the Studio bundle stays lean.

## Phases

1. **Router foundation** — react-router, persistent app shell + nav rail, routes; retire the
   binary mode toggle. _(no behavior change to Studio/Canvas)_
2. **Vision + Scenes backend** — `VisionAdapter` (fal), scene schema + storage CRUD, server
   routes, runtime wiring.
3. **Scenes page** — upload → describe → review/edit → Send to Studio.
4. **Library page + Character detail** — promote the slide-over to full pages.
5. **Series + Settings** — long-form grouping; provider availability + defaults.

Each phase ends green on typecheck + tests + web build, self-reviewed for side effects.
