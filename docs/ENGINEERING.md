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
one `style` (theme text, model, **locked seed**, true **9:16** dims (768×1344, the SDXL/fal-friendly
portrait bucket), **weighted style references** (`style.anchors[]`, `{hash, weight}`), baked no-text
`negative`), a reusable **reference library** (`project.library[]`, `{hash, label}`), an editable
`promptTemplate`, and an ordered list of `frames`. Each frame: id, prompt, optional seed override,
`resultHash` (the selected image), and `variants[]` (`{hash, seed}` iteration history, server-authoritative).

**Context engineering.** `composeFramePrompt` substitutes `{story}/{settings}/{style}/{frame}` tokens
deterministically, then **drops dangling labels** when a token is empty (no `"Setting:"` with no value)
— the UI's "final prompt" preview is byte-identical to what runs.

**Compilation.** `compileComic(project)` emits, per frame, a `generate.text-to-image` → `io.export`
pair with **frame-id-based node ids** (`gen-<id>`/`export-<id>`) so reorder/remove never remaps cache
keys or misroutes progress events. Seed precedence: `frame.seed ?? style.seed`.

**Consistency.** Three stacked anchors: shared style text + one locked seed + reference images.
References are **two-tier**: a project-wide set of **weighted style references** (`style.anchors[]`, each
`{hash, weight}`, look) plus a **cast** of recurring **characters** (`project.cast[]`, each
`{id, name, refHashes[]}`, identity). Both draw from a single reusable **reference library**
(`project.library[]`) — upload or "bank" an image once, then attach it as a style reference and/or to any
character without re-uploading; removing a library entry detaches every usage so nothing dangles. A third,
**per-frame** lever is **scene continuity** (`frame.continuesFrameId`): one frame *continues* another
frame's scene, so the source frame's current image (`frameImageHash` = `resultHash ?? newest variant`) is
fed in as the **strongest, leading** reference at full weight. Because that reference routes the run to an
**edit endpoint** (see below), a bare image otherwise pins the source pixel-for-pixel and silently defeats
any "new camera angle" prompt. So continuity also carries an **intent** (`frame.continuesMode`,
`ContinuesMode`) that `composeFramePrompt` lowers into a trailing **continuity directive**
(`continuityDirective`) telling the edit model how to use the reference: `"restage"` (default,
`DEFAULT_CONTINUES_MODE`) = keep setting/light/palette/character design but re-compose with a new camera and
blocking; `"shot"` = preserve the exact composition/camera and edit in place. The directive is appended only
when a continuity reference actually resolves (same gate as the compiler), so preview, compile and run stay
identical and a dangling/self/imageless link emits nothing. Self-links, unknown ids and
not-yet-generated sources resolve to nothing, so reordering/deleting frames never breaks a run (the store
also clears links pointing at a removed frame). Per
frame, `frameReferences` (`packages/shared/src/comic.ts`) resolves the ordered, deduped, **weighted** set
— the continuity reference first (full weight, so it dominates), then style references (each with its
weight), then each active cast member's refs at full weight (first
occurrence wins on dedup, so a shared image keeps its strongest/earliest weight) — gated by `frame.characterIds`
(tri-state: `undefined` = whole cast, `[]` = none, `[ids]` = subset; unknown ids ignored so deleting a
character never breaks a frame). That set flows as `references` (`[{hash, weight}]`) →
`NormalizedInput.references` (`packages/nodes/src/image.ts`). **Back-compat:** the legacy single
`style.anchorHash` is migrated on read by `styleReferences()` (used when `anchors` is empty), and the node
still accepts the old flat `referenceHashes` + shared `referenceWeight` for direct graph users.

The fal adapter **actually consumes** references on **Nano Banana Pro** and **FLUX.2 [pro]**, with two
real-API subtleties the adapter handles (verified against fal's live schemas):
- **Edit-endpoint routing.** On fal the base text-to-image endpoints reject image inputs; references live
  on *separate* edit endpoints (`…/gemini-3-pro-image-preview/edit`, `…/flux-2-pro/edit`, field `image_urls`,
  base64 data URIs OK). The adapter routes to the edit endpoint **iff a run supplies references**, otherwise
  the base t2i endpoint. `consumesReferences` is **derived from `editEndpoint`** (not a hand-set flag), so a
  model can never advertise references it has no endpoint to apply — the earlier "flag set on a t2i-only
  endpoint" bug is now structurally impossible. References are capped at each endpoint's `maxReferences`
  (FLUX.2 9, Nano Banana 5) with a warning, never a silent 422.
- **Per-model dimension mapping.** Gemini/Nano Banana takes **no `image_size`** — it uses an `aspect_ratio`
  enum. `geminiMapInput` maps the comic's 9:16 pixel dims to the nearest ratio, so a 9:16 comic is actually
  9:16 on that model instead of its default square-ish. (FLUX/SDXL keep `image_size`.)

Adapters with no edit endpoint (mock, Seedream, Qwen, Z-Image) ignore references, and the node's
`cacheKeyParams` **drops both `references` and the legacy `referenceHashes` from the cache key for them**,
so toggling an anchor on a model that can't use it is a cache hit, not a wasted re-bill. The sidebar shows
a **capability-aware warning** when a cast/anchor (or LoRA) is set on a model that ignores it, pointing at
a compatible model (`consumesReferences`/`consumesLoras` are surfaced in the model manifest).

**Per-reference weight semantics:** each style reference carries an independent 0..1 `weight`, plumbed
through `references` → `ReferenceInput.weight` to the adapter. fal's current edit endpoints accept no
per-image weight field, so the **primary lever the vendor honors is order** (earlier = stronger) —
`frameReferences` emits style refs first, in the artist's order. The stored weight drives that intent in
the UI and reaches any adapter able to apply it (an IP-Adapter-style endpoint), rather than being discarded.

The UI exposes this as: a **Style references** strip (multiple thumbnails, each with a weight slider;
multi-image drag/drop & paste), a **Reference library** panel (rename/remove banked images, one-click
`+ style` / `+<character>` to attach anywhere), a **Cast manager** (add/name characters, attach
references), per-frame **membership pills** (which characters appear), and **"★ as style ref"** / **"as
ref →"** one-clicks that bank a generated frame as a style reference or a character's reference — the
"character sheet" workflow.

A fourth anchor is **trained LoRAs**: `style.loras[]` (`{path, scale, name}`) are house-style adapters
applied to every frame, compiled onto the gen node's `loras` param and mapped by LoRA-capable models —
**`fal/flux-2-lora`** (FLUX.2 [dev], the recommended default), **`fal/qwen-image-lora`** (best in-image
text, up to 3 merged LoRAs), and the legacy **`fal/flux-lora`** (FLUX.1) (`consumesLoras: true` → fal
`loras: [{path, scale}]`). Like references, the node's `cacheKeyParams` drops `loras` from the cache key on
models that ignore them, so a LoRA on a non-LoRA model is a cache hit. The sidebar has a **Style LoRAs**
editor (URL/hub-id + scale per row). LoRA = the strongest *fixed-style* lock; references = per-shot
*character identity* — they compose.

**Iteration (artwork workflow).** Every successful generation appends a `{hash, seed}` variant
(`unionVariants`, deduped, capped at `MAX_VARIANTS`). The **🎲 vary** action rolls a fresh seed and
regenerates one frame; the per-frame **variant strip** lets the artist pick a past iteration, which
restores both its image and seed (reproducible). `runOne`/`targets` bills only that frame's sub-DAG.

**In-place image edit (refine workflow).** Distinct from continuity (which references *another* frame),
the **✎ Edit** action iterates on a frame's *own* image: pick a base (any variant, or an upload), describe
the change, and an edit-capable model applies it. `compileEditFrame` (`packages/shared/src/comic.ts`)
lowers it to a **single `generate.text-to-image` node** keyed by the frame's own `gen-<id>` (so live
preview/progress route to the frame like a normal run, no `io.export` — the hash is read back from the run
result). `editReferences` leads the set with the **chosen base at full weight** (so the edit endpoint
builds on it), then — when *Keep style & characters* is on — the project's style refs + the frame's active
cast, deduped (base wins). The instruction drives the prompt via `composeEditPrompt`, which leads with the
artist's text and trails an **edit directive** (`editDirective`, `EditMode`): `"tweak"` (default) preserves
composition/camera/lighting/identity and changes only what's asked; `"restage"` keeps the look but frees the
camera/pose — the same shot-vs-restage axis as continuity, applied to a self-edit. Each edit appends a new
selected variant (so edits chain — the editor re-homes its base onto the fresh result); seed defaults to a
fresh roll per edit (explore) unless locked (reproduce). Server route **`POST
/api/comics/:id/frames/:frameId/edit`** (`EditBody`) shares the `/run` plumbing (runId/cancel, `"*"`
brackets, WS preview routing) and persists via the same `update()` + `unionVariants` write-back. Gated on
`consumesReferences`: on a model that ignores references the editor disables Generate with a
capability-aware warning (a plain t2i pass would ignore the base).

**Cost efficiency.** A persistent `FileOutputCache` (`packages/storage/src/output-cache.ts`, wired in
`runtime.ts`) stores node outputs as sharded JSON under `~/.vengine/cache`, so an unchanged frame stays
free **across server restarts** — the key lever for iterative paid generation (the old in-memory cache
re-billed every restart). Preview/Final quality + dry-run `/plan` (confirm-before-spend) round it out.

**Persistence (local-first, JSON).** `ProjectStore` (`packages/storage/src/project-store.ts`) writes
`~/.vengine/projects/<id>/{project.json, frames/, snapshots/}`. Writes are atomic (unique temp +
rename) and the whole read-modify-write is **serialized per id by an in-process mutex**. `save`
union-merges `variants` and never clobbers `resultHash` with undefined; the run write-back uses
`update()` to edit the **latest** doc under the lock, so edits made during a long run aren't lost.

**Server** (`apps/server/src/comics.ts`): comics CRUD, snapshots, `/plan`, `/run` (compile →
`executor.run` with `targets`; captures freshly streamed hashes so a cancelled/failed run still
persists finished frames), **`POST /api/comics/:id/frames/:frameId/edit`** (in-place image edit; see
*In-place image edit* above), **`POST /api/runs/:runId/cancel`** (AbortController registry — stops paid
spend mid-run; client learns the runId from the WS start event), and `POST /api/assets` (multipart,
image-only, 25 MB cap) for anchor upload.

**UI** (`apps/web/src/comic/*`, `comicStore.ts`): storyboard is the default view (node canvas behind a
`ModeToggle`), built on the `components/ui` design system. Settings sidebar + a wrapping 9:16 frame
grid with live per-frame status, regen, **vary**, variant strip, "set as anchor", reorder, and a
**Cancel** button while running. Saves are **serialized and deferred during a run** (then flushed),
and the client adopts the run's authoritative outputs; failures surface as **toasts** (sonner).

**Concurrent generation.** Runs are **independent and overlap**: state is tracked per frame (`inFlight[]`,
not a single global lock), so the artist can fire a frame, then start others while it renders — each frame's
own controls disable only while *it* generates. Three entry points all funnel through `runFrames(ids)`:
per-frame **▶**, **🎲 vary**, a header **checkbox** + toolbar **Generate selected (N)** (batch a chosen
subset), and **Generate all**. `runFrames` skips any frame already in flight (no double-billing) and on
finish releases only its own frames; deferred edits flush once *everything* settles, so a full-document PUT
can't clobber another run's write-back. Each run is bracketed by a `"*"` WS event (tracked in
`activeRunIds[]`); WS progress is matched by **frame id** so overlapping runs route correctly, and **Cancel**
aborts every in-flight run.

**Deferred follow-ups:** a cheaper reference-capable model (Seedream v4 has a `…/v4/edit` endpoint — wire
`editEndpoint` once its field/limit is confirmed, giving $0.03 character consistency vs Nano Banana's
$0.15); reference weights (blocked on upstream support, see above); a reference
port + Character node for canvas power users; partial-result capture
for nodes that finish *after* an early run failure (their bytes persist in the asset store but aren't
relinked — the executor would need to await in-flight on failure).

## 17. AI Text Assist (implemented)

A field-aware "fix my text" layer over every prose input in the Comic Studio — polish, fix
grammar, enrich, or shorten the story, settings, style theme, per-frame prompts, the prompt template,
and the negative prompt. The default action everywhere is the **conservative `polish`** (light
grammar/clarity fix, no new content), so the AI never imposes its own style — `enrich` is an explicit
opt-in. It is **additive and opt-in**: when no text-model key is set the buttons simply don't render,
so nothing depends on it.

**Text/LLM provider abstraction.** A textual sibling to the image `ModelAdapter`:
`TextAdapter` (`packages/providers/src/text/types.ts`) normalizes a neutral `ChatMessage[]` and hides
each vendor's wire format; `TextProviderRegistry` mirrors `ProviderRegistry`. Phase-1 adapter is
**Kimi / Moonshot** (`text/kimi.ts`), config-driven over Moonshot's OpenAI-compatible
`/chat/completions` (`KIMI_KEY`, base `https://api.moonshot.ai/v1`, default model **`kimi-k2.6`**).
K2.x are reasoning models: they emit hidden `reasoning_content` before the answer (ignored — `content`
is the clean reply) and require `temperature: 1`, so the adapter pins that and uses a generous
`max_tokens` (4096) so reasoning never starves the reply. Adding a vendor (Claude, OpenAI) = one
adapter; the routes and UI don't change.

**Shared config (single source of truth).** `packages/shared/src/assist.ts` holds the `AssistField`
and `AssistMode` enums (`polish` · `grammar` · `enrich` · `shorten`, conservative → heavy), per-field
metadata (`defaultMode` is `polish` for prose, `grammar` for the structural template), the
`AssistRequestSchema` (a `refine` rejects a mode not offered for the field), and **`buildAssistContext(project, field, frame?)`**
— a deterministic builder that gathers the surrounding material most useful for revising *this* field
(a frame prompt gets story + settings + style + its position + active cast names), so the model always
knows which input it is editing.

**Seeded prompts (server).** `apps/server/src/assist.ts` composes the system prompt from three
config maps: a `GLOBAL_SYSTEM` (a strict *conservative copy editor* charter — smallest change, keep the
author's words/length/formatting, add no new ideas or art direction, never fold the context's style or
setting into the field), a per-field `FIELD_PROMPTS` ("what this input is"), and a per-mode
`MODE_PROMPTS` ("what to do"). The context is passed as background only and explicitly must not be
copied into the output (this was the fix for early over-eager rewrites). Empty input + *enrich* still
lets the model **draft a short, plain first version from context**. The reply is run through
`stripWrappingQuotes`. Routes: `POST /api/assist` (validated, key/model resolved
server-side, vendor errors surfaced as 502/503) and `GET /api/assist/config` (availability probe).
Text providers are wired in `runtime.ts` (`rt.textProviders`); the default model id is `kimi/k2`.

**UI.** `AssistTextarea` (`apps/web/src/comic/AssistTextarea.tsx`) is the single integration point —
a `Textarea` plus an inline `AiAssistButton` (sparkle = the field's default action, a caret opens the
other modes). Callers swap `value`/`onChange` for `value`/`onValueChange`, which receives both manual
edits and AI revisions (so the normal debounced autosave persists them). The button is gated on
`assistAvailable` (probed once in `comicStore.init`), shows a spinner per in-flight mode, and toasts on
error. Wired into all prose fields in `ProjectHeader` and the per-frame prompt in `FrameCard`.
