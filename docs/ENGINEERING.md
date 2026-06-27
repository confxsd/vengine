# vengine — Engineering Design Document

> A ComfyUI-like, node-based **visual engine** for generating consistent, production-grade
> image artworks via remote model APIs (Higgsfield, fal.ai, Chinese models) plus a local
> compositing/post pipeline — with an optional Claude/MCP intelligence layer.

**Status:** Draft v0.1 · **Owner:** solo · **Date:** 2026-06-27

---

## 1. Goals & Non-Goals

### Locked constraints (from kickoff)
| Decision | Choice |
|---|---|
| **Audience / scale** | Personal / solo tool. Single user, local-first. No multi-tenant auth/billing. |
| **Outputs** | **Images** + **compositing / post** (stitching, layers, color, overlays, batch export). No video/audio in v1. |
| **Model hosting** | **API-only.** No GPUs to operate. Aggregators + direct provider APIs. |
| **Stack** | **TypeScript + React**, node-graph UI. Node backend. |

### Goals
1. **Modular & expandable** — adding a new model or a new node is a single registry entry, no core changes.
2. **Consistent results** — first-class support for reference images, seeds, character/style consistency, and deterministic re-runs.
3. **Efficient & cost-aware** — API calls cost real money; the engine must *cache aggressively* and only re-run what changed.
4. **Practical & customizable** — reusable sub-graphs, presets, batch generation, parameter sweeps.
5. **Modern, fresh, minimal UI** — dark, calm, high-signal canvas; not a cluttered ComfyUI clone.

### Non-Goals (v1)
- Video / audio generation (architecture leaves room; not built).
- Self-hosted model inference / GPU orchestration.
- Multi-user accounts, sharing, billing, cloud sync.
- Training / fine-tuning (may consume LoRAs via API, won't train them).

---

## 2. Research Summary (mid-2026 landscape)

The single most important architectural finding: **don't integrate N model vendors directly — front them with an aggregator and a thin adapter layer.**

### 2.1 Aggregators (the backbone)
- **fal.ai** — ~50% market share for image APIs, **400+ image models** behind one async/queue API, typically **30–50% cheaper** than Replicate, and the exclusive/early host for many models (Nano Banana Pro, Recraft, Seedream, Qwen, Flux.2, Z-Image). **→ Primary provider.** One integration unlocks most of the catalog.
- **Replicate** — fewer models (~200), per-second GPU billing, better docs/community. **→ Secondary / fallback** for models fal lacks.
- **Higgsfield Cloud API** — credit-based, strong on cinematic presets and its own models (Seedream/Flux/GPT-Image exposed via credits); historically video-first. **→ Optional adapter** for Higgsfield-exclusive looks.

### 2.2 Models worth wiring first (images)
| Model | Vendor | Strength | Indicative price |
|---|---|---|---|
| **Nano Banana Pro** (Gemini 3 Pro Image) | Google | Best text rendering, identity preservation across up to 5 subjects, editing | ~$0.09–0.15/img (fal/kie) |
| **Seedream 5.0 / Lite** | ByteDance | Photoreal, strong composition | ~$0.03–0.035/img |
| **Qwen-Image 2.0** | Alibaba | Best-in-class text/typography, instruction following (open weights) | ~$0.02/MP |
| **Z-Image-Turbo** | Alibaba Tongyi | Top open-source on Image Arena, sub-second, cheapest | ~$0.005/img |
| **Flux.2 [pro/dev]** | Black Forest Labs | Western workhorse, Kontext editing | ~$0.04/img |

Takeaway: the **provider abstraction must normalize across "per-image", "per-megapixel", and "per-second" billing**, and across **sync vs async/webhook** execution — fal is queue-first.

### 2.3 Reference architecture to borrow: ComfyUI's engine
ComfyUI compiles a workflow (JSON) into a **DAG**, does **topological sort**, executes nodes in dependency order, and **caches intermediate results with content-based cache keys** (a node with identical inputs — including all ancestor outputs — reuses its cached result). It supports **lazy evaluation** of optional inputs. We adopt this execution model wholesale; we drop everything about GPU/VRAM memory management (irrelevant for API-only).

> **Sources:** [fal.ai](https://fal.ai/) · [fal vs Replicate (pricepertoken)](https://pricepertoken.com/image) · [fal vs Replicate (TeamDay)](https://www.teamday.ai/blog/fal-ai-vs-replicate-comparison) · [Nano Banana Pro on fal](https://fal.ai/models/fal-ai/gemini-3-pro-image-preview) · [Chinese image models 2026](https://www.secondtalent.com/resources/chinese-llms-for-ai-image-generation/) · [Qwen-Image](https://github.com/QwenLM/Qwen-Image) · [Higgsfield Cloud API](https://cloud.higgsfield.ai/) · [Higgsfield pricing](https://higgsfield.ai/pricing) · [ComfyUI execution engine (DeepWiki)](https://deepwiki.com/comfyanonymous/ComfyUI/2.2-memory-management) · [ComfyUI graph execution & caching](https://deepwiki.com/hiddenswitch/ComfyUI/4.2-graph-execution-and-caching) · [React Flow](https://reactflow.dev/) · [awesome-node-based-uis](https://github.com/xyflow/awesome-node-based-uis)

---

## 3. High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│  WEB CLIENT  (React + Vite + TypeScript)                               │
│                                                                        │
│  ┌────────────┐  ┌──────────────┐  ┌───────────────┐  ┌────────────┐   │
│  │ Node Canvas│  │ Inspector /  │  │ Asset Gallery │  │ Run / Queue│   │
│  │ (React Flow│  │ Param panel  │  │ + Lightbox    │  │ panel      │   │
│  └────────────┘  └──────────────┘  └───────────────┘  └────────────┘   │
│        │  graph edits (Zustand store) ── autosave ──►                   │
└────────┼───────────────────────────────────────────────────────────────┘
         │ HTTP + WebSocket (run progress, node status, previews)
┌────────▼───────────────────────────────────────────────────────────────┐
│  CORE SERVER  (Node + TypeScript · Hono/Fastify)                        │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │  EXECUTION ENGINE                                                 │  │
│  │   parse graph → DAG → topo sort → cache lookup → run → emit       │  │
│  │   • content-addressed cache  • partial re-run  • concurrency/RL   │  │
│  └───────────────┬───────────────────────────┬──────────────────────┘  │
│                  │                            │                          │
│  ┌───────────────▼─────────┐   ┌──────────────▼───────────────────────┐ │
│  │  NODE REGISTRY          │   │  PROVIDER REGISTRY (adapters)         │ │
│  │  generation / compositing│   │  fal · replicate · higgsfield · ...   │ │
│  │  / io / logic nodes      │   │  normalize: submit→poll/webhook→asset │ │
│  └─────────────────────────┘   └──────────────┬───────────────────────┘ │
│                                                │ HTTPS                    │
│  ┌─────────────────────┐  ┌──────────────────┐ │                         │
│  │ ASSET STORE (local  │  │ DB (SQLite)      │ │   ┌──────────────────┐  │
│  │ content-addressed   │  │ graphs/runs/keys │ │──►│ Image model APIs │  │
│  │ files + thumbnails) │  │ assets metadata  │ │   │ (fal/replicate…) │  │
│  └─────────────────────┘  └──────────────────┘ │   └──────────────────┘  │
│  ┌──────────────────────────────────────────┐  │                         │
│  │ COMPOSITING (sharp / libvips, local)      │  │                         │
│  └──────────────────────────────────────────┘  │                         │
│  ┌──────────────────────────────────────────────▼──────────────────────┐ │
│  │ INTELLIGENCE LAYER (optional): Claude API node + MCP server          │ │
│  │  prompt expansion · brief→graph · let Claude drive the engine         │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
```

**Why a server at all (vs pure browser)?** Secrets (API keys) must never reach the client; image compositing via libvips is server-side; the cache and asset store are filesystem-backed. The client stays a thin, fast renderer.

---

## 4. Core Concepts

### 4.1 Typed node & port model
Every node declares typed input/output **ports**. The type system is what makes the graph safe and the UI ergonomic (only compatible ports connect).

Core port types: `Image`, `Mask`, `ImageBatch`, `Prompt`, `String`, `Number`, `Int`, `Seed`, `Boolean`, `Enum`, `Color`, `Model` (a model selection + its params), `Reference` (image+weight for consistency).

```ts
// packages/core/src/node.ts
export interface PortDef {
  id: string;
  type: PortType;
  label: string;
  required?: boolean;        // optional inputs support lazy evaluation
  multiple?: boolean;        // accept fan-in (e.g. layer stack)
}

export interface NodeDefinition<P = Record<string, unknown>> {
  type: string;              // unique, e.g. "generate.text-to-image"
  category: NodeCategory;    // generation | compositing | io | logic | intelligence
  title: string;
  inputs: PortDef[];
  outputs: PortDef[];
  params: ParamSchema<P>;    // zod schema → auto-generates the inspector UI
  /** Pure-ish executor. Receives resolved inputs + params + ctx (provider, cache, assets). */
  execute(args: NodeExecuteArgs<P>): Promise<NodeOutputs>;
  /** Stable hash of params that affect output (excludes purely cosmetic fields). */
  cacheKeyParams?(params: P): unknown;
}
```

Nodes are **registered**, never hard-wired:
```ts
nodeRegistry.register(textToImageNode);
nodeRegistry.register(blendNode);
// adding a model/feature = one register() call → the SOLID/expandable requirement
```

### 4.2 Execution engine (the heart)
1. **Parse** the client graph (nodes + edges) into an internal DAG; reject cycles.
2. **Topological sort** to get execution order respecting dependencies.
3. For each node, compute a **content-addressed cache key**:
   `hash(nodeType · version · cacheKeyParams · sortedUpstreamOutputHashes)`.
4. **Cache hit → skip execution**, reuse stored output hash/asset. **This is the cost-control core**: editing a downstream color node never re-bills the upstream generation.
5. **Cache miss → execute.** Generation nodes go through the provider layer (async). Compositing nodes run locally.
6. **Stream** per-node status (`queued · running · cached · done · error`) + thumbnails to the client over WebSocket.
7. **Lazy inputs**: optional ports are only resolved if the node actually needs them.

Concurrency: a bounded worker pool with **per-provider rate limits + retry/backoff**, so a 50-image batch doesn't get throttled or hammer one vendor.

### 4.3 Determinism & consistency (a product pillar)
- Every generation node exposes `seed` (with "lock seed" + "randomize" toggles).
- **Reference ports** carry image + weight; `Model` adapters that support identity/style refs (Nano Banana Pro multi-subject, Flux Kontext, Seedream refs) map them through.
- A **"Character" node** holds a named reference set reused across a project → consistent subjects across many generations.
- Cache + locked seeds = bit-identical re-runs unless an upstream param truly changes.

---

### 4.4 Cost, time & efficiency strategy
Because every generation node bills real money and adds latency, efficiency is a
first-class engine concern, not an afterthought. Mechanisms (✅ = built in `@vengine/core`):

1. **Content-addressed caching** ✅ — a node with identical type/version, output-affecting
   params, and *input content* reuses its result. Editing a downstream color node never
   re-bills the upstream generation. (`computeCacheKey`, `OutputCache`.)
2. **Execute-to-target** ✅ — `run(graph, { targets })` prunes to the sub-DAG that feeds the
   node you care about, so previewing one node never runs (or pays for) unrelated branches.
   (`collectRequired`.)
3. **Cost dry-run / confirm-before-spend** ✅ — `executor.plan(graph)` walks the DAG, does
   *real cache lookups but no execution*, classifies each node cached-vs-will-run, and totals
   estimated USD. A node is predicted to run iff it's a cache miss or sits downstream of one.
   The UI shows "this run will cost ~$X" and gates anything above a threshold. (`RunPlan`,
   `NodeDefinition.estimateCost`.)
4. **Preview quality mode** ✅ (engine hook) — `run(graph, { quality: 'preview' })` flows a
   `RenderQuality` to generation nodes so they pick a cheap/fast path (lower res, fewer steps,
   or a cheaper model like Z-Image-Turbo @ ~$0.005) for iteration, then a `final` pass only
   when the user commits. Generation adapters implement the actual cheap path (M2).
5. **In-flight coalescing** ✅ — identical cache-miss nodes within one run (e.g. duplicated
   sub-branches in a batch/sweep) execute exactly once.
6. **Bounded concurrency** ✅ — DAG-parallel execution capped by a concurrency limit;
   per-provider rate-limiting + retry/backoff lands in the provider layer (M2).
7. **Live previews & progressive feedback** ✅ (protocol) — `NodeProgressEvent` carries a
   `previewHash` and per-node `cost`, so the client streams thumbnails and a running cost
   meter as the DAG executes, rather than waiting for the whole run.

> Net effect for a solo creator: iterate cheaply in preview mode, see the bill before you
> commit, and only ever pay for the exact nodes whose inputs actually changed.

## 5. Provider Abstraction Layer

The contract every model integration implements. New vendor = new adapter; the engine and UI don't change.

```ts
// packages/providers/src/types.ts
export interface ModelAdapter {
  id: string;                       // "fal/nano-banana-pro"
  provider: "fal" | "replicate" | "higgsfield" | string;
  displayName: string;
  capabilities: Capability[];       // text-to-image | image-to-image | inpaint |
                                    // upscale | bg-remove | reference | edit
  inputSchema: ZodSchema;           // normalized params (size, steps, refs, mask…)
  pricing: PricingModel;            // { kind: 'per-image'|'per-mp'|'per-second', ... }
  /** Submit + resolve. Hides sync vs async/webhook/polling behind one promise. */
  run(input: NormalizedInput, ctx: ProviderCtx): Promise<GeneratedAsset>;
}
```

- **Normalization** maps the engine's neutral params (`size`, `aspect`, `steps`, `guidance`, `references[]`, `mask`) onto each vendor's quirks.
- **Billing normalization**: every run reports estimated + actual cost into the DB → a live **cost meter** in the UI and per-run budgets.
- **Execution normalization**: fal's queue/webhook, Replicate's prediction polling, Higgsfield's credit jobs all resolve to the same `Promise<GeneratedAsset>`.
- **Capability-driven UI**: a generation node only shows the controls its selected model supports (no mask slot if the model can't inpaint).

**Phase-1 adapters:** `fal` (covers Nano Banana Pro, Seedream, Qwen, Z-Image, Flux.2). **Phase-2:** `replicate`, `higgsfield`.

---

## 6. Compositing / Post Pipeline (local, no API cost)

Server-side via **`sharp` (libvips)** — fast, no GPU. These nodes are free to run and re-run, so the cache matters less but consistency matters more.

v1 compositing nodes: `Load Image`, `Resize`, `Crop / Pad`, `Mask`, `Blend (layer + mode + opacity)`, `Layer Stack` (fan-in), `Color Adjust` (levels/curves/HSL), `Text Overlay`, `Watermark`, `Background Remove` (via provider), `Upscale` (via provider), `Export` (format/quality/naming, batch).

This is what turns raw generations into **deliverables** — the second half of the user's stated scope.

---

## 7. Data Model & Persistence (local-first)

**SQLite** (`better-sqlite3`) for metadata; **content-addressed filesystem** for binaries.

```
graphs(id, name, json, created_at, updated_at)        -- the node graph document
runs(id, graph_id, status, cost_estimate, cost_actual, started_at, finished_at)
node_runs(id, run_id, node_id, cache_key, status, output_hash, cost, error)
assets(hash PRIMARY KEY, mime, width, height, bytes, source_node, created_at)
presets(id, name, node_type, params_json)             -- reusable param sets
projects(id, name)  +  characters(id, project_id, name, reference_asset_hashes)
secrets(provider, encrypted_key)                       -- see §9
```

- **Asset store:** `~/.vengine/assets/<sha256[:2]>/<sha256>` + a `thumbs/` sidecar. Content addressing = automatic dedup and a natural cache substrate.
- **Graph document** is a versioned JSON blob (ComfyUI-compatible *spirit*: nodes/edges/params) → portable, diffable, shareable.
- **Cache** keys (§4.2) map to `assets.hash`, so the generation cache *is* the asset store.

---

## 8. Intelligence Layer (Claude / MCP) — optional, additive

Three integration points, all opt-in:
1. **Prompt-craft node** — a Claude API node that expands a short brief into an optimized, model-specific prompt (and negative prompt), or critiques/iterates on a generated image.
2. **Brief → graph** — Claude assembles or modifies a sub-graph from a natural-language goal ("make a 3-panel product hero set, consistent lighting").
3. **MCP server** — expose the engine's nodes/runs as an **MCP server** so Claude Code (or Claude desktop) can *drive* vengine: enqueue runs, inspect assets, tweak params. This makes the engine scriptable by an agent without a custom API.

Uses the latest Claude models (e.g. Opus/Sonnet 4.x) via the Anthropic SDK. Kept behind the same provider-style abstraction so it's never load-bearing for core image work.

---

## 9. Security & Secrets

- API keys live **only on the server**, encrypted at rest in the `secrets` table (AES-GCM with a key derived from OS keychain / a local master passphrase). Never serialized into graph JSON, never sent to the client.
- Client receives presigned/proxied asset URLs from the local server only.
- Since it's a localhost solo tool: bind to `127.0.0.1`, no exposed ports; optional single-user token for the WS/HTTP API.

---

## 10. Tech Stack Decisions

| Concern | Choice | Rationale |
|---|---|---|
| Language | **TypeScript** end-to-end | One type system across client/server/core; matches your conventions. |
| Monorepo | **pnpm workspaces + Turborepo** | Shared `core`/`providers` packages, fast incremental builds. |
| Client | **React + Vite** | Fast HMR, matches stack choice. |
| Node canvas | **React Flow (xyflow)** | Purpose-built for React, nodes *are* React components, best ecosystem/design freedom for a modern minimal UI. (Rete is an alternative but less React-native.) |
| Client state | **Zustand** | Minimal, fast, great for canvas + autosave; avoids Redux ceremony. |
| Styling | **Tailwind + Radix primitives** | Minimal, modern, consistent dark UI without a heavy component lib. |
| Server | **Node + Hono** (or Fastify) | Lightweight, TS-first, easy WS. |
| Validation | **Zod** | One schema drives param validation *and* auto-generated inspector UI. |
| DB | **SQLite (better-sqlite3)** | Zero-ops, local-first, synchronous + fast for a solo tool. |
| Image ops | **sharp (libvips)** | Fast CPU compositing, no GPU. |
| Realtime | **WebSocket** | Per-node run progress + live previews. |
| Testing | **Vitest** + Playwright (canvas smoke) | TS-native. |

---

## 11. Proposed Project Structure

```
vengine/
├─ apps/
│  ├─ web/                  # React + Vite client (canvas, inspector, gallery)
│  └─ server/              # Hono server: HTTP + WS, run endpoints
├─ packages/
│  ├─ core/                # node model, execution engine, cache, type system
│  ├─ nodes/               # node definitions (generation/compositing/io/logic)
│  ├─ providers/           # ModelAdapter contract + fal/replicate/higgsfield
│  ├─ compositing/         # sharp-based ops
│  ├─ db/                  # SQLite schema, migrations, repositories
│  └─ shared/              # zod schemas, types shared client↔server
├─ docs/
│  └─ ENGINEERING.md       # this document
└─ ...
```
Service/repository pattern in `packages/db`; no direct model access from routes.

---

## 11.5 Secrets & Deployment

### Keys
Server-only env vars, resolved as `${PROVIDER}_KEY`. **`FAL_KEY` is the only one needed
to start** (covers Nano Banana Pro, Seedream, Qwen, Z-Image, Flux.2). Optional:
`REPLICATE_KEY`, `HIGGSFIELD_KEY`, `ANTHROPIC_API_KEY`. Copy `.env.example` → `.env`
(gitignored); the server loads it at boot, real env vars win. Keys never reach the client —
all model calls are proxied server-side.

### Where to run it — recommendation: **don't deploy, run local-first**
This is a single-user, API-only tool. The server holds your keys and bills real money per
generation, so the safest and simplest home is **localhost** (bind `127.0.0.1`, zero public
attack surface). `pnpm dev`. Later, package as a desktop app (**Tauri** > Electron: smaller,
Rust shell) for a one-click install — still local.

**If you genuinely need remote access** (use it from your phone / another machine), the
API-only design makes hosting cheap (no GPU): a single small instance on **Fly.io / Railway /
Render** or a cheap VPS, with a persistent volume for `~/.vengine/assets`. But the moment it's
public you MUST add: (1) a single-user **auth token** on every `/api` + WS route, (2) HTTPS,
(3) keys in the **platform secret manager** (not a committed file), (4) a hard **spend cap** +
per-run budget so a leaked endpoint can't run up your fal bill, (5) rate limiting. Treat a
public URL as a liability, not a feature, for a personal tool.

### Deploy best practices (whichever path)
- Keys server-side only; `.env` gitignored; encrypt-at-rest if ever multi-user (§9).
- Cost guardrails are code, not vibes: `plan()` dry-run + budget cap + cache-first (§4.4).
- Pin provider SDK/endpoint versions; handle vendor 4xx/5xx with retry/backoff per provider.
- Asset volume is the only stateful piece — back it up; everything else is reproducible.
- Health check (`/api/health`) + structured run logs for observability.

---

## 12. Non-Functional Requirements

- **Cost control:** live cost meter, per-run budget cap with confirm-before-spend, cache-first execution, dry-run estimate before any paid batch.
- **Performance:** topo execution with bounded concurrency; thumbnails for gallery; lazy-load full assets.
- **Resilience:** per-provider retry/backoff, partial-failure isolation (one failed node doesn't kill the run), resumable runs.
- **Observability:** structured run logs, per-node timing + cost, error surfacing in the inspector.
- **Portability:** graph documents and assets fully exportable; nothing locked to a vendor.

---

## 13. Roadmap (phased, modular)

**M0 — Foundations.** ✅ Monorepo, shared types, node/port model, execution engine
with content-addressed caching + dry-run planner + target pruning + preview quality +
coalescing. Headless, 18 engine tests. *(SQLite cache deferred to M2; MemoryCache for now.)*

**M1 — Vertical slice.** ✅ `@vengine/providers` (mock + fal adapters), `@vengine/storage`
(content-addressed asset store), nodes (`Text-to-Image`, `Load Image`, `Resize`, `Export`),
`apps/server` (Hono + WS: run/plan/models/nodes/assets endpoints + live progress broadcast),
and `apps/web` (React Flow canvas, inspector, preview/final toggle, cost estimate, live status,
inline image previews). Runs generate→resize→export end-to-end in the browser, offline.
Run locally: `pnpm dev` (server :5174 + web :5173).

**M2 — Generation depth.** Image-to-image, inpainting, upscaling, background removal; reference/character node; seed locking; model picker driven by capabilities; cost meter.

**M3 — Compositing.** sharp nodes: resize/crop/blend/layers/color/text/watermark/batch export. Turn generations into deliverables.

**M4 — Productivity.** Presets, reusable sub-graphs/groups, batch & parameter sweeps, project/character library.

**M5 — Intelligence.** Claude prompt-craft node + MCP server to let Claude drive the engine.

**M6 — Polish.** UI refinement (minimal/modern pass), keyboard-first workflow, more adapters (replicate, higgsfield).

---

## 14. Open Questions / Risks

1. **fal API specifics** — exact async/webhook contract & per-model param shapes need a spike against live docs before M1 (build a throwaway script first).
2. **Higgsfield image API maturity** — it's video-first; confirm image endpoints justify an adapter, or defer to M6.
3. **Local server vs Electron** — start as localhost web app (simplest); revisit packaging as a desktop app (Electron/Tauri) later if you want a one-click install.
4. **Mask authoring UX** — inpainting needs an in-canvas mask painter; non-trivial, scope carefully in M2.
5. **Secret storage** — confirm OS-keychain integration vs master-passphrase for the encrypted secrets table.

---

## 15. Immediate Next Step

Before writing engine code, do a **1-hour fal.ai spike**: a standalone script that submits a text-to-image job, polls the queue, and downloads the result — to pin down the real async contract and param normalization. That de-risks M0/M1. Then scaffold the monorepo (M0).

---

## 16. Comic Studio (implemented)

A storyboard layer for the primary use case — **contemporary-art comics: ~4 frames, 9:16 vertical,
single drawing, no text overlay**. It is a thin product layer that **compiles down to the existing
engine** (executor, content-addressed cache, asset store, WS progress) with zero core changes.

**Model.** A `ComicProject` (`packages/shared/src/comic.ts`) holds a main `story`, shared `settings`,
one `style` (theme text, model, **locked seed**, 9:16 dims, optional **anchorHash** reference image,
baked no-text `negative`), an editable `promptTemplate`, and an ordered list of `frames` (each: id,
prompt, optional seed override, server-authoritative `resultHash`).

**Context engineering.** `composeFramePrompt` substitutes `{story}/{settings}/{style}/{frame}` tokens
deterministically — the UI's "final prompt" preview is byte-identical to what runs.

**Compilation.** `compileComic(project)` emits, per frame, a `generate.text-to-image` → `io.export`
pair with **frame-id-based node ids** (`gen-<id>`/`export-<id>`) so reorder/remove never remaps cache
keys or misroutes progress events. Seed precedence: `frame.seed ?? style.seed`.

**Consistency.** Shared style text + one locked seed + an optional anchor image. The anchor is wired
as `referenceHashes` (params, so it folds into the cache key) → fetched from the asset store →
`NormalizedInput.references` (`packages/nodes/src/image.ts`). Reference-capable model adapters consume
it; **mock/offline ignores it** (style+seed still give consistency).

**Persistence (local-first, JSON — SQLite deferred).** `ProjectStore`
(`packages/storage/src/project-store.ts`) writes `~/.vengine/projects/<id>/{project.json, frames/,
snapshots/}`. Atomic writes; `save` **merges `resultHash` by frame id** so a client autosave that
omits it never clobbers a run's output. Snapshots are point-in-time copies.

**Server** (`apps/server/src/comics.ts`): comics CRUD, snapshots, `/plan` (confirm-before-spend),
`/run` (compile → `executor.run` with `targets` for single-frame regen → persist hashes), and
`POST /api/assets` (multipart) for anchor upload.

**UI** (`apps/web/src/comic/*`, `comicStore.ts`): storyboard is the default view (node canvas behind a
`ModeToggle`). Project settings sidebar + a wrapping 9:16 frame grid with live per-frame status,
per-frame regen, "set as anchor", reorder, debounced autosave, and snapshot.

**Deferred follow-ups:** fal reference-image upload (a fal-storage spike + per-model `mapInput`);
a **persistent `OutputCache`** (engine cache is in-memory, so unchanged frames are free only within a
server lifetime — `resultHash`/exported files survive restarts for display, but fal recompute re-bills
after restart); Claude prompt-enhance; a reference port + Character node for canvas power users.
