# vengine — Strategy & Know-How

The durable knowledge base for the *project behind the engine*: not how the code works
(that's [ENGINEERING.md](../ENGINEERING.md) / [VISUAL_STUDIO.md](../VISUAL_STUDIO.md)), but
**what we're building it for and how to win.** Written 2026-06-30 from a deep codebase
investigation + multi-stream web research. Iterate freely.

## The ambition, in one paragraph

Own an **IP universe by authoring a myth.** The seed: insert an invented rabbit, **Yue**, into
Chinese mythology beside a reinterpreted **Sun Wukong** — a *fabricated-but-genuine* mythology,
serious and philosophical, but delivered in **accessible, popular visual styles** to reach
public and commercial scale. It starts as **4-frame, 9:16 vertical art comics for Instagram
Reels**, moves to a **dedicated web page**, then a **long-form comic format**, then **IP
products** (books, prints, editions, collectibles) — and can expand sideways into
**contemporary-art works** (sculptures of Wukong and Yue; a piece titled *"The Possibility of
Fiction"*). vengine is the production engine that makes the visual output **consistent, cheap,
and repeatable** enough for one person to sustain a universe for years.

## The documents

| Doc | What it covers |
|---|---|
| **[MYTH-IP-STRATEGY](./MYTH-IP-STRATEGY.md)** | The intellectual spine: why an authored myth can be "true" (Tolkien, Borges, hyperstition, fakelore, Baudrillard/Flusser); how Yue grafts onto real Chinese myth (Wukong & the Jade Rabbit already share JTTW Ch.95); contemporary-art framing (parafiction, invented archives, Superflat); transmedia & canon management for one person. |
| **[PRODUCT-STATE](./PRODUCT-STATE.md)** | Ground-truth of what vengine actually does today vs. the roadmap; the gap list; engineering priorities tied to the goal. |
| **[BUSINESS-MODEL](./BUSINESS-MODEL.md)** | Monetization stack (verified platform fees), the rented→owned→revenue funnel, storefront/fulfillment, the art-toy/edition tier, and sequencing from zero audience. |
| **[TECH-AND-PIPELINE-RESEARCH](./TECH-AND-PIPELINE-RESEARCH.md)** | AI consistency tech to adopt + vertical-comic production/publishing specs. **Partial** — two research streams were cut off (see *Pending* below). |

## The through-line (read this if nothing else)

The myth strategy and the engineering agree on one principle: **consistency is the whole game,
at every level.**
- **Philosophically**, an invented myth "feels genuine" through *inner lawfulness* — a locked
  cosmology never violated (Tolkien's Secondary Belief; one curated canon database).
- **Visually**, vengine produces the *same* law: locked seed + style + character/style LoRAs +
  reference-intent → the same Yue, the same world, across hundreds of panels.
- **Commercially**, the same consistent frames repackage into every revenue stream (Reel →
  book page → print → collectible), and the myth is what turns followers into *enlistees*.

So the work isn't three projects (art / tech / business) — it's **one discipline of coherence**
expressed in three registers. Build for coherence and everything compounds.

## What I found (headlines)

1. **The engine is genuinely strong where it counts** — consistent 9:16 sequential art, a
   production-ready durable LoRA trainer, reference-intent (compose/match, restage/shot) that
   solves the "it keeps generating the same image" problem most tools fail at. The "batman"
   storyboard proves it works.
2. **Every remaining gap is on the "finish & publish" side** — no lettering, no multi-page/strip
   assembly, no publish-ready export (Reels/carousel/webtoon/print), minimal compositing, and the
   Library/Scenes/Series pages are stubbed. *The factory works; the packaging line doesn't exist.*
3. **The myth has a rare gift of legitimacy** — Sun Wukong and the moon-rabbit **already coexist
   in Chapter 95 of *Journey to the West***. Yue isn't a splice; it's the next link in a
   2,000-year accretive tradition that already includes a humanoid benevolent rabbit (Tu'er Ye).
4. **The art-world register is a feature, not a distraction** — an articulated thesis ("The
   Possibility of Fiction," a Superflat-style manifesto) lets the commercial comic and the gallery
   sculptures be the *same* mythology in two voices, and the seriousness protects pricing
   everywhere below it.
5. **The business is a funnel, not a platform bet** — rented reach (Reels/Webtoon) → owned email
   list → memberships/books/prints/editions/licensing. Own-site + a Merchant-of-Record checkout
   keeps margin; the list is the deed.

## Recommended next moves (prioritized)

**Product / engine** (detail in [PRODUCT-STATE](./PRODUCT-STATE.md) §"priorities"):
1. **Lettering / caption layer** — unblocks the philosophical core; needed on every surface.
   (Decide v1: wordless art + caption-as-post-copy may be the right minimal start.)
2. **Export presets** — Reels 1080×1920 w/ safe zones, carousel 4:5, Webtoon 800px strip, print
   300DPI; + an upscale step (frames are sub-1080px). Cheapest path to a real audience.
3. **Wire Seedream v4 `/edit`** — ~$0.03 character consistency vs $0.15; makes daily posting sane.
4. **First-class Yue/Wukong character LoRAs + finish the Library/Character pages** (trainer is
   ready; wire the stubbed UI + the existing sheet-ingestion).
5. **Page/strip assembly + a static reader-site generator** — the "dedicated web page" stage.
6. Later: Vision/Scenes, Series, image→video for Reels motion, MCP/"brief→storyboard".

**Myth / IP**:
- Start a lean **Obsidian world bible now** (two-doc discipline, graded canon, track promises).
- Draft the **"The Possibility of Fiction" manifesto** — it licenses everything downstream.
- Lock Yue's design + 3–5 signature motifs (extractable tokens) and the Chinese-myth anchors
  (Guanghan Palace, the elixir/mortar-pestle, Chang'e, Taiyin Xingjun, Mid-Autumn, Tu'er Ye).

**Business**:
- Begin the **email list on day one** with a lead-magnet "first fragment."
- Publish Reels consistently for 6 months to prove the world exists; monetize digital-first only
  after a list exists; reserve the crowdfunded book and editions for when the list can carry them.

## Pending research (resume after session-limit reset — 3pm Europe/Istanbul)

Three deep web-research streams **completed their searches but were cut off at final synthesis**
by the account session limit on 2026-06-30:
- **AI character/style consistency 2026** — searches done, synthesis lost.
- **Vertical-comic production & publishing** — searches done, synthesis lost.
- **IP monetization deep dive** — searches done, synthesis lost; **but its fee fact-check
  survived and is captured** in [BUSINESS-MODEL](./BUSINESS-MODEL.md) §1.

To resume: re-run those three research agents (or `/deep-research`) and fold results into
[TECH-AND-PIPELINE-RESEARCH](./TECH-AND-PIPELINE-RESEARCH.md) (which lists the exact open-question
checklist) and [BUSINESS-MODEL](./BUSINESS-MODEL.md). Everything else in this folder is complete
and verified.
