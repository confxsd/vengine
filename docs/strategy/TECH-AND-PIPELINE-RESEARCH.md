# Tech & Pipeline Research — consistency, vertical-comic production, publishing

What the engine should adopt to be more consistent, accurate, and useful — and how vertical
comics are actually produced and published.

Companion docs: [README](./README.md) · [PRODUCT-STATE](./PRODUCT-STATE.md) ·
[BUSINESS-MODEL](./BUSINESS-MODEL.md).

> **Status — PARTIAL.** The two web-research streams behind this doc (AI character/style
> consistency 2026, and vertical-comic production/publishing) **completed their searches but
> were cut off at final synthesis by an account session limit (resets 3pm Istanbul).** This doc
> records (a) what is already established and encoded in the codebase + ENGINEERING.md, and (b)
> the specific open questions to resolve when the streams resume. Treat unverified claims as
> hypotheses. See [README](./README.md) "Pending research" to resume.

---

## A. Character & style consistency — current understanding

### What the project already does well (and the research validated the *approach*)
The three-anchor stack + reference-intent design is sound and matches 2026 best practice:
- **Locked seed** (deterministic backbone) + **style text/negative** + **reference images**,
  with **trained LoRAs** as the strongest lock (style LoRA = fixed look; character LoRA =
  identity). This is the right hierarchy.
- **Reference *intent* (compose vs match / restage vs shot)** is the standout idea. The root
  problem — "a bare reference on an edit endpoint silently pins the composition so the prompt
  can't move the camera" — is real and widely hit; encoding intent as a directive is a genuinely
  good solution that most tools lack.

### The known technique landscape (to verify/expand on resume)
- **Multi-reference identity models** (Nano Banana Pro ≤5 subjects; FLUX.2 ≤9; Seedream v4
  edit) — strongest for *zero-training* character consistency across panels. **Cost is the
  lever:** Nano Banana ($0.15) is the quality ceiling; **Seedream v4's `/v4/edit` (~$0.03)** is
  the cost breakthrough to wire (PRODUCT-STATE gap #7). *Open: confirm Seedream v4 edit's field
  name, max refs, and whether it preserves identity as well as Nano Banana.*
- **Character LoRA** — the gold standard for a *recurring* cast member who appears in hundreds of
  panels: train once, then identity is free at inference and survives any composition. The engine
  already trains these (FLUX.2 trainer). **For Yue specifically, a character LoRA is almost
  certainly worth it** vs paying $0.15/frame for reference-based identity forever. *Open: optimal
  image count + captioning strategy for a stylized (non-photoreal) character LoRA; how many
  steps; whether to train style and character separately (yes, almost certainly) and stack them.*
- **IP-Adapter / InstantID / PuLID-style identity** — strong for *photoreal faces*; less relevant
  for a stylized myth character, but worth knowing if Yue ever needs a "human" register. *Open:
  current best API-exposed identity adapter in 2026 and whether it beats a trained LoRA for
  stylized art.*
- **Composition control while keeping identity** — ControlNet (pose/depth/canny), regional
  prompting. The engine has *none* of this; it relies on prompt + reference-intent. For reliable
  *staging* (Yue here, Wukong there, this camera angle), pose/depth control would be a real
  upgrade. *Open: which fal/replicate endpoints expose ControlNet for the models in use; is it
  worth the complexity vs. the current restage/shot directives.*
- **Panel-to-panel continuity / in-context editing** — Kontext-style and Nano Banana `/edit`
  already power the engine's continuity + in-place edit. *Open: any newer 2026 model purpose-built
  for sequential/multi-panel consistency; whether "generate N consistent panels in one call"
  endpoints exist and beat per-frame generation.*
- **In-image text rendering** — Qwen-Image and Nano Banana Pro are the strong text renderers.
  This matters for the **lettering gap**: if captions/titles can be rendered *in-image* reliably,
  that's one option (vs an overlay layer). *Open: how reliable is in-image philosophical text at
  paragraph length in 2026 — likely still better to letter as an overlay for control.*
- **Image-to-video for Reels** — none in the engine. Even subtle motion (parallax, drift, a
  blink) lifts Reels reach. *Open: best 2026 image→video API for short looping motion from a
  single comic frame, cost per clip, and whether it preserves the art style.*

### Concrete engine upgrades implied (consistency)
1. **Wire Seedream v4 `/edit`** → 5× cheaper reference-based consistency.
2. **First-class Yue/Wukong character LoRAs** + a guided "train a cast member" flow (the training
   backend is ready; the UI/Library page is stubbed).
3. **Consider ControlNet pose/depth** for deliberate staging (medium effort, high payoff for
   sequential art).
4. **Evaluate one image→video adapter** for Reels motion (new modality; architecture leaves room).

---

## B. Vertical-comic production & publishing — current understanding

> This entire section is the part most affected by the cut-off research stream. Specs below are
> from general knowledge and need a live-source confirmation pass.

### Format & specs (to confirm)
- **Instagram Reels / vertical video:** 9:16, **1080×1920**, with **safe zones** (keep text/key
  art clear of the bottom ~250px UI and top ~120px). The engine's 768×1344 frames are 9:16 but
  **below 1080px wide** — a publish step should upscale to ≥1080×1920. *Open: 2026 IG safe-zone
  pixels, max length, cover-frame spec.*
- **Instagram carousel (the "4-panel comic" native format):** **4:5, 1080×1350** is the
  feed-optimal portrait ratio; carousels of 1:1 or 4:5 panels are the classic comic format and
  swipeable. *Decision point: the project's signature is 9:16 single frames — for feed carousels
  a 4:5 export may read better; for Reels keep 9:16.* *Open: current best-performing comic format
  on IG in 2026 (Reels vs carousel vs single).*
- **Webtoon vertical-scroll:** infinite-canvas vertical strip, **800px wide** content (Webtoon
  standard), tall panels with generous gutters tuned for thumb-scroll pacing. The engine has **no
  long-strip assembly** (PRODUCT-STATE gap #2). *Open: Webtoon Canvas exact upload dims/file
  limits in 2026.*
- **Print (the book / art book):** 300 DPI, CMYK, bleed + safe margin. The engine exports RGB at
  screen res only; a print path needs upscaling + color/bleed handling. *Open: POD printer specs
  (e.g. for the crowdfunded book).*

### Lettering & typography (the biggest creative gap)
- For a *philosophical* comic, text is core, not decoration. Options, roughly in order of control:
  1. **Overlay layer (recommended default)** — letter captions/titles as a separate typographic
     layer over the generated art. Maximum control of font, kerning, placement, edit-after-the-
     fact, and localization. Requires a text/overlay node the engine doesn't have yet.
  2. **In-image rendering** — let Qwen/Nano Banana render short text in the image. Lower control,
     risk of garbled text at length; fine for a single title word or a sign.
  3. **Caption-as-post-copy** — the philosophical text lives in the IG caption / web reader, not
     on the art. Keeps the art "pure" (the current single-drawing aesthetic) and is the lowest-
     effort start. *This may be the right v1: art stays wordless; meaning travels in the caption
     and the web reader.*
- *Open: webtoon/comic lettering conventions and tools (Clip Studio, Photoshop) in 2026; tasteful
  caption styles for art-comics; whether a lightweight in-app letterer is worth building vs.
  exporting to a dedicated tool.*

### Workflow & where the engine fits
- Indie webtoon pipelines: Clip Studio Paint / Photoshop for art + lettering + page assembly →
  export. **vengine replaces the *generation* step and (today) nothing else.** To own more of the
  pipeline it needs: page/strip assembly, a letterer (or clean hand-off), and publish-export.
- *Open: 2026 indie tooling for panel/page assembly; whether to build assembly into vengine or
  export cleanly to Clip Studio; how AI-generation pipelines are being integrated by working
  webtoon creators.*

### Publishing platforms (to confirm pros/cons + 2026 mechanics)
- **Instagram** — discovery, top of funnel. **Webtoon Canvas** — discovery + credibility, 50% ad
  share, high thresholds (see BUSINESS-MODEL). **Substack / dedicated site** — owned audience +
  long-form. **GlobalComix / Tapas** — alternative comic homes. For a *serious/philosophical
  art-comic*, the owned site + a curated platform presence likely beats chasing mainstream-webtoon
  algorithms. *Open: 2026 platform economics + which best fit a non-mainstream art-comic.*

### Concrete engine upgrades implied (production)
1. **Export presets**: Reels 1080×1920 (safe zones), carousel 4:5 1080×1350, Webtoon 800px strip,
   print 300DPI/CMYK/bleed. Highest-leverage, relatively low effort.
2. **Page/strip assembly**: order frames into a scrollable strip and/or paged spreads.
3. **Text/overlay node** (or a small letterer) for captions/titles — unblocks the philosophical core.
4. **A static reader-site generator** from a project (the "dedicated web page" stage).
5. **Upscale step** in the publish path (frames are sub-1080px).

---

## Open questions to resolve when research resumes (the checklist)

**Consistency tech**
- [ ] Seedream v4 `/edit`: field name, max refs, identity quality vs Nano Banana, true cost.
- [ ] Best 2026 *character-LoRA* recipe for a stylized character (image count, captioning, steps).
- [ ] Best API-exposed *style-LoRA* practice; stack style+character LoRAs reliably?
- [ ] Is ControlNet (pose/depth) worth wiring for staging? Which endpoints, which base models?
- [ ] Any 2026 model purpose-built for multi-panel/sequential consistency or N-consistent-panels-
      per-call?
- [ ] Best image→video API for short Reels motion from a comic frame (style-preserving, cost).
- [ ] In-image long-text reliability in 2026 (decides letter-in-image vs overlay).

**Production & publishing**
- [ ] 2026 IG specs: Reels safe zones, carousel best practice, which format performs for comics.
- [ ] Webtoon Canvas 2026 upload dims/limits + realistic Canvas economics for a niche art-comic.
- [ ] Lettering conventions/tools + tasteful caption styles for philosophical art-comics.
- [ ] Indie page/strip assembly tooling; build-vs-handoff decision for vengine.
- [ ] Platform comparison (Webtoon/Tapas/GlobalComix/Substack/own-site) for a serious art-comic.
- [ ] IG growth playbook for art/comic accounts in 2026 (cadence, formats, funnel to email).
- [ ] Print/POD specs for the eventual crowdfunded book and art prints.
