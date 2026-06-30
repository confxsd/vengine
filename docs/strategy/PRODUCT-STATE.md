# Product State — what is actually built (2026-06-30)

A ground-truth map of vengine as it exists today, from a deep read of the code (not the
roadmap aspirations). Use this to decide what to build next against the IP-universe goal.
Companion docs: [README](./README.md) · [MYTH-IP-STRATEGY](./MYTH-IP-STRATEGY.md) ·
[BUSINESS-MODEL](./BUSINESS-MODEL.md) · [TECH-AND-PIPELINE-RESEARCH](./TECH-AND-PIPELINE-RESEARCH.md).

## TL;DR

vengine is a **working, polished single-creator engine for generating consistent 4-frame,
9:16 vertical art comics**, plus a **production-ready LoRA-training pipeline** and a
cross-project asset library. The generation/consistency core is genuinely strong. The gaps
are all on the **"turn frames into a published, sellable artifact"** side: no lettering, no
multi-page/page-assembly, no publish-ready export, minimal compositing, and the Library /
Scenes / Series pages are stubbed.

In one line: **the factory works; the packaging line and the shop floor don't exist yet.**

---

## What works today (verified in code)

### Comic Studio (the primary surface, `/`)
- **Storyboard of N frames**, 9:16 vertical (default 768×1344, the SDXL/fal portrait bucket).
- **Per-frame**: prompt (with AI text-assist), seed override, generate ▶, 🎲 vary (fresh
  seed), variant history strip (pick any past iteration → restores image + seed), delete
  variant, ✎ in-place edit, "★ as style ref" / "as character ref" shortcuts, reorder.
- **Concurrent generation** — frames run independently and overlap; per-frame in-flight
  tracking, a header checkbox for batch "Generate selected (N)", and "Generate all". Cancel
  stops paid spend mid-run (AbortController registry).
- **Three consistency anchors stack**: shared style text + one locked seed + reference
  images, plus **trained LoRAs** (strongest fixed-style lock) and **character LoRAs**
  (strongest identity lock, applied only on frames where that character appears).
- **Reference intent is the killer feature** — solves "it keeps generating the same image":
  - `referenceMode` **compose** (default; use refs for identity/wardrobe/palette/style only,
    build a NEW composition) vs **match** (copy the reference's layout). This is character-
    LoRA / IP-Adapter / `--cref` semantics, made explicit.
  - `continuesMode` **restage** (keep world/light/palette/design, new camera & blocking) vs
    **shot** (preserve exact composition, edit in place) for scene-to-scene continuity.
  - Exactly one directive is emitted per frame (continuity wins over reference), so the
    "final prompt" preview is byte-identical to what runs.
- **Cast manager** (recurring characters with `refHashes` + optional character LoRA),
  **weighted style references** (ordered; earlier = stronger, since fal edit endpoints honor
  order not per-image weight), per-frame references, and a **reusable reference library**
  (bank an image once, attach as style ref and/or to any character; remove cascades-detach).
- **In-place edit** (✎): pick a base (any variant or upload), describe the change, tweak vs
  restage, optional keep-style-&-characters. Edits chain.
- **Cost control**: dry-run `/plan` ("this run will cost ~$X", cached vs will-run), preview
  vs final quality toggle, persistent content-addressed cache that survives server restarts
  (unchanged frame = free), per-frame cost in the live WS stream.
- **AI text-assist** on every prose field (polish/grammar/enrich/shorten) via Kimi/Moonshot,
  hidden when no key is set.

### Engine (`packages/core`)
- DAG compile → topo sort → cycle/type validation → **content-addressed caching** (keys on
  type · version · output-affecting params · upstream output hashes · quality).
- **Dry-run planner** (real cache lookups, no execution, totals USD), **target pruning**
  (only run the sub-DAG feeding the node you want), **in-flight coalescing**, **bounded
  concurrency** (default 4), **preview/final** quality, **AbortSignal** cancel, **persistent
  FileOutputCache** under `~/.vengine/cache`.

### LoRA training (`apps/server/src/training.ts`, production-ready)
- Durable, **restart-resumable**: a record is created the instant training starts (status
  `training`), job handle persisted, poll loop re-attaches on boot, deadline anchored to job
  createdAt. Terminal transitions broadcast over WS.
- Two curated fal trainers: **`fal/flux-2-trainer`** (default, no trigger word, caption-
  driven, $0.008/step → ~$8/1000 steps, base model `fal/flux-2-lora`) and **`fal/flux-lora-
  fast-training`** (FLUX.1, trigger word, ~$0.0006/step → ~13× cheaper, base `fal/flux-lora`).
- Trains **subject (character)** and **style** LoRAs. Dataset built as an inline base64 ZIP
  of images (+ optional `.txt` captions), re-encoded to JPEG ≤1024px (warns >12 MB).

### Character-sheet ingestion (XY-cut, `packages/providers/src/adapters/sheet.ts`)
- Upload a character sheet → deterministic **XY-cut segmentation** (projection profiles,
  recursive whitespace-gutter cuts) → a **review grid** that pre-selects regions that "look
  like a pose" (aspect/area heuristic) → user picks → each crop is banked to the asset store
  and appended to a character's `refHashes`. Two routes: `/segment`, `/extract`. Fully
  implemented (server + algorithm); **no UI wired to call it yet**.

### Models wired in the fal adapter (8 image models)
| Model | Endpoint | Refs (max) | LoRAs (max) | Price | Notes |
|---|---|---|---|---|---|
| **Nano Banana Pro** (Gemini 3 Pro Image) | `gemini-3-pro-image-preview` (+`/edit`) | ✅ 5 | — | **$0.15/img** | best identity across ≤5 subjects; aspect-ratio enum (true 9:16); best in-image text |
| **FLUX.2 [pro]** | `flux-2-pro` (+`/edit`) | ✅ 9 | — | $0.04/img | Western workhorse, Kontext-style edit |
| **Seedream 4.0** | `bytedance/seedream/v4/text-to-image` | ❌ | — | **$0.03/img** | photoreal; has a `/v4/edit` endpoint NOT yet wired (cheap-ref opportunity) |
| **Qwen-Image** | `qwen-image` | ❌ | — | $0.02/MP | best typography |
| **Z-Image Turbo** | `z-image/turbo` | ❌ | — | **$0.005/img** | cheapest, sub-second, ideal preview model |
| **FLUX.2 [dev] + LoRA** | `flux-2/lora` | ❌ | ✅ | $0.021/MP | recommended LoRA inference target |
| **Qwen-Image 2512 + LoRA** | `qwen-image-2512/lora` | ❌ | ✅ 3 | $0.02/MP | best in-image text + LoRA |
| **FLUX.1 [dev] + LoRA** | `flux-lora` | ❌ | ✅ | $0.035/MP | legacy fast-trainer target |
| mock/gradient | — | — | — | free | offline deterministic |

Capability gating is structural: `consumesReferences` is **derived from the presence of an
edit endpoint** (can't advertise refs it can't apply), and `cacheKeyParams` **drops refs/LoRAs
from the cache key on models that ignore them** (toggling them is a cache hit, not a re-bill).
The sidebar warns when a cast/anchor/LoRA is set on a model that ignores it.

---

## What is NOT built (the gap list)

Ordered roughly by how much each blocks the IP-universe path.

### Blocks "publish a finished comic"
1. **Lettering / text / captions** — none. The default negative prompt actively *excludes*
   text. For a *philosophical* comic, words are not optional; this is the single biggest gap.
   (No balloon/caption system, no typographic overlay, no font handling.)
2. **Multi-page / page assembly** — a project is a flat list of frames; there is no page,
   chapter, or spread concept, and no way to stitch frames into a vertical-scroll webtoon
   strip or a print page.
3. **Publish-ready export** — only per-frame PNG/JPEG/WebP via `io.export`. No webtoon
   long-strip, no PDF, no print-spec (CMYK/bleed/DPI), no Reels-sized canvas with safe zones,
   no carousel export.
4. **Drag-reorder** — only move-left/move-right buttons.

### Blocks "richer composition & post"
5. **Compositing is essentially absent** — only `compositing.resize` is real. No crop, blend,
   layer stack, color grade, text overlay, or watermark, despite being in the roadmap. The
   crop primitives exist (`cropRegion`/`cropPreview` in sheet.ts) but aren't exposed as nodes.
6. **No inpaint / mask painter** — `editEndpoint` routes whole-image references only; no
   region masking. `inpaint`/`upscale`/`bg-remove` capabilities are declared but unimplemented.
7. **Cheap reference model** — Seedream v4 has a `/v4/edit` endpoint that would give ~$0.03
   character consistency vs Nano Banana's $0.15; field/limit confirmation pending, not wired.

### Stubbed (schema/algorithm exists, UI/route missing)
8. **Library / Character-detail / Scenes / Series / Settings pages** — all five routes are
   placeholder stubs. The Library *data layer* (characters, styles, trainedLoras) and the
   cross-project store are fully working behind the still-mounted slide-over; the full pages
   aren't.
9. **Vision (image→text / Scenes)** — `SceneReference`/`SceneBreakdown` schema is defined but
   there is **no VisionAdapter, no route, no storage CRUD**. The "upload a sample scene → get
   a structured breakdown → regenerate in my style" loop is unbuilt.
10. **Series** — schema only; no CRUD, no UI, no project→series back-reference.

### Out of scope today (by design, but relevant to the ambition)
11. **No video / image-to-video / animation** — zero infra. Matters because Instagram Reels
    rewards motion; even a 2–4s Ken-Burns or subtle parallax per frame would lift reach.
12. **No logic/intelligence nodes in the graph** — text/LLM provider exists for prompt-assist
    but isn't graph-exposed; no "brief → storyboard" generation; no MCP server yet (M5).
13. **No web-publishing target** — the README is explicit: local-first, single-user, bind to
    127.0.0.1. There is no public reader site, no CMS, no store. The "dedicated web page" and
    "web store" stages of the plan are greenfield.

---

## Engineering priorities implied by the goal

The user's path is **Instagram Reels → dedicated web page → long-form comic → IP products.**
Mapping the gaps onto that path, the highest-leverage build order:

1. **Lettering + caption layer** (unblocks the philosophical core; needed for *every* surface).
2. **Reels/IG export presets** (9:16 1080×1920 with safe zones; 4:5 1080×1350 carousel; optional
   image→video micro-motion) — the cheapest path to an audience.
3. **Page/strip assembly + webtoon long-strip & PDF export** (unblocks "web page" + "long-form").
4. **Wire the Seedream v4 edit endpoint** (5× cheaper character consistency → makes daily
   posting economically sane).
5. **Finish the Library + Character-detail pages and wire sheet-ingestion UI** (the cast is the
   IP; managing it well compounds over years).
6. **Vision/Scenes** (turn reference photos / other art into your-style prompts — a strong
   ideation accelerator) and **Series** (the durable home for a multi-chapter mythology).
7. Later: a **public reader site generator** + **store** (see BUSINESS-MODEL).

See [README](./README.md) for how these sequence against the business and myth strategy.
