/**
 * Extend the **btas-noir** style pack with a curated BTAS reference set.
 *
 * The pack's original four anchors are all night-time dark-deco *environments*
 * (cityscape, boardroom, alley, street) — beautiful, but the model never sees a
 * genuine production cel of a *character* in the style: no close-ups, no
 * two-shots, no action, no warm palettes, no weather, no interiors. This script
 * appends ten verified Batman: The Animated Series (1992–95) images that fill
 * those gaps, and labels + tags every anchor so the per-frame selector
 * (`selectStyleAnchors` in shared/comic) can match each frame to the anchors
 * that teach what it needs — a close-up frame gets the close-up cels, a storm
 * rooftop fight gets the lightning rooftop, a dusk scene gets the warm script.
 *
 *   1. Red-sun rooftop silhouette two-shot    — warm crimson palette, figures as shapes
 *   2. GCPD deco cityscape w/ bat-signal      — dense deco detail, warm window grid
 *   3. Mr. Freeze face-off                    — villain medium close-up, cold steel-blue
 *   4. Lightning rooftop low-angle            — storm magenta, hero pose between deco slabs
 *   5. Joker with playing card                — key-lit figure on black, spotlight shading
 *   6. Batman grabs the Joker                 — dynamic action two-shot over night city
 *   7. Alley rim-lit back shot                — electric-pink lightning rim, ultramarine alley
 *   8. Burnt-orange dusk skyline              — warm sky background painting
 *   9. Joker extreme close-up                 — tilted-camera face shading, flat cel planes
 *  10. Warm interior confrontation (Man-Bat)  — brown/maroon interior, over-shoulder staging
 *
 * Idempotent: fetches the pack, keeps whatever anchors it already has (the
 * original four stay first = strongest), appends any missing ones, fills in
 * missing labels/tags (never overwrites ones you edited), uploads missing
 * images from the local asset store, and upserts the pack. Safe to re-run.
 *
 *   pnpm --filter @vengine/server seed:btas-anchors [--local]
 */
import { AssetStore } from "@vengine/storage";
import type { ComicReference, StylePack } from "@vengine/shared";
import { ensureAssets, getJson, login, putJson, REMOTE_URL } from "./remote-client.js";

interface SeedAnchor {
  hash: string;
  label: string;
  tags: string[];
}

/** The four original dark-deco environment anchors (seed-batman.ts) — kept first. */
const ORIGINAL_ANCHORS: SeedAnchor[] = [
  {
    hash: "1e01328b58904796da3af4a33e681c8524575ddd3c2ed0d007ba4d2024e3e5b6",
    label: "Deco cityscape at night",
    tags: ["wide", "city", "night", "establish"],
  },
  {
    hash: "0473c5d985014ba8569522625139dbb0dd9160a1b8c79dc9a7a40792372f90ff",
    label: "Deco boardroom interior",
    tags: ["interior", "medium"],
  },
  {
    hash: "2d5dd64f873eaf25ecebeedf17a1452417a68f2f93b0a9f4f0fc012f40921fdd",
    label: "Dark alley",
    tags: ["alley", "night"],
  },
  {
    hash: "6902877c1cfe9afaf86cd962bd96d398de21c9bae0a45081091ce952e19d2ed0",
    label: "Gas-lamp night street",
    tags: ["street", "night", "city"],
  },
];

/** Verified production-cel extensions (see header for what each one teaches). */
const NEW_ANCHORS: SeedAnchor[] = [
  {
    hash: "4150e8eec5fa56a1770ab09dab7b55cb09034bf8245ccd530e055857bd59ec28",
    label: "Red-sun rooftop two-shot",
    tags: ["twoshot", "warm", "silhouette", "rooftop"],
  },
  {
    hash: "9fa8b8eeef876684da9100fc036db30881adf55c39cc9c01655b0bfbaad56887",
    label: "GCPD skyline + bat-signal",
    tags: ["wide", "city", "night", "establish"],
  },
  {
    hash: "a7a3760685a55fc1d52c43a7e31b384af784aa75d048ea093eb0c57b8202c1bb",
    label: "Mr. Freeze face-off",
    tags: ["closeup", "villain", "cold"],
  },
  {
    hash: "b79346537743e77679b87226e5caa7f7d3ea7847294472136c6e215dfd4df982",
    label: "Lightning rooftop low-angle",
    tags: ["wide", "lowangle", "storm", "rooftop", "action"],
  },
  {
    hash: "4fa0ae756831892e3701b21b035769358976a7bd35d25b3f40f9ec7461bc5b40",
    label: "Joker with card (spotlit)",
    tags: ["closeup", "spotlight", "villain"],
  },
  {
    hash: "b9abdb0130a4efaa7f1acc30e27bea53f3a35cea1219a343920b365a445f0338",
    label: "Batman grabs the Joker",
    tags: ["action", "twoshot", "night"],
  },
  {
    hash: "9eb1a8789bcabe13745aa824430d5655648fa15cbe61a384c03d0f27d3abe9fa",
    label: "Alley rim-lit back shot",
    tags: ["alley", "night", "silhouette", "storm"],
  },
  {
    hash: "f3314ff4ed388b4733bb77fe11bc12d851f4e786f713bee2f7bd4d85d661fc1d",
    label: "Burnt-orange dusk skyline",
    tags: ["wide", "city", "warm", "establish"],
  },
  {
    hash: "d51bd4482a8d97eb1d27eef9da0587344a363f0dd4a90e0989cb07735c0c7cd6",
    label: "Joker extreme close-up",
    tags: ["closeup", "villain"],
  },
  {
    hash: "cea38d6dbb94d4d46c6f7b285c06ec10dc2d81b80c2cc2d3a4d920df8e7ac634",
    label: "Warm interior confrontation",
    tags: ["interior", "warm", "twoshot"],
  },
];

const STYLE_ID = "btas-noir";

async function main() {
  if (process.argv.includes("--local")) process.env.SYNC_REMOTE_URL = "http://localhost:5174";
  console.log(`Extending “${STYLE_ID}” anchors → ${process.env.SYNC_REMOTE_URL ?? REMOTE_URL}`);
  await login();

  const library = await getJson<{ styles: StylePack[] }>("/api/library");
  const pack = library.styles.find((s) => s.id === STYLE_ID);
  if (!pack) throw new Error(`Style pack “${STYLE_ID}” not found — run seed:batman first.`);
  const existing = pack.anchors ?? [];
  const have = new Set(existing.map((a) => a.hash));
  const seeded = new Map([...ORIGINAL_ANCHORS, ...NEW_ANCHORS].map((a) => [a.hash, a]));

  // Original four lead (strongest) — but only when the pack doesn't already
  // carry them; the existing-entries pass below enriches in place and never
  // overwrites a label/tags you edited by hand.
  const merged: ComicReference[] = [];
  for (const seed of ORIGINAL_ANCHORS) {
    if (!have.has(seed.hash)) {
      merged.push({ hash: seed.hash, weight: 1, label: seed.label, tags: seed.tags });
    }
  }
  for (const anchor of existing) {
    const seed = seeded.get(anchor.hash);
    merged.push(
      seed
        ? {
            ...anchor,
            label: anchor.label ?? seed.label,
            tags: anchor.tags ?? seed.tags,
          }
        : anchor,
    );
  }
  for (const seed of NEW_ANCHORS) {
    if (!have.has(seed.hash)) {
      merged.push({ hash: seed.hash, weight: 1, label: seed.label, tags: seed.tags });
    }
  }
  // Dedupe keeping first occurrence (originals lead, hand-added preserved).
  const seen = new Set<string>();
  const deduped = merged.filter((a) => (seen.has(a.hash) ? false : (seen.add(a.hash), true)));
  const added = deduped.length - existing.length;
  if (added <= 0) {
    console.log(
      `  nothing to add — pack already carries all ${NEW_ANCHORS.length} extensions` +
        (deduped.some((a) => !a.tags) ? " (filling in missing labels/tags)" : ""),
    );
  }

  const local = new AssetStore();
  await ensureAssets(deduped.map((a) => a.hash), local, "reference image");

  await putJson("/api/library/styles", { ...pack, anchors: deduped });
  const tagged = deduped.filter((a) => a.tags?.length).length;
  console.log(
    `  ✓ “${pack.name}”: ${existing.length} → ${deduped.length} anchors (+${Math.max(added, 0)}), ${tagged} labelled+tagged`,
  );
  console.log("\nDone — every new frame now draws on the anchors that match its shot, scene and palette.");
}

main().catch((err) => {
  console.error("seed-btas-anchors failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
