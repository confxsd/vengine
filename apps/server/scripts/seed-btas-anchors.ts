/**
 * Extend the **btas-noir** style pack with a curated BTAS reference set.
 *
 * The pack's original four anchors are all night-time dark-deco *environments*
 * (cityscape, boardroom, alley, street) — beautiful, but the model never sees a
 * genuine production cel of a *character* in the style: no close-ups, no
 * two-shots, no action, no warm palettes, no weather, no interiors. This script
 * appends ten verified Batman: The Animated Series (1992–95) images that fill
 * those gaps, each one a distinct composition / color-script lesson:
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
 * original four stay first = strongest), appends any missing ones, uploads
 * missing images from the local asset store, and upserts the pack. Safe to
 * re-run; never removes an anchor you added by hand.
 *
 *   pnpm --filter @vengine/server seed:btas-anchors [--local]
 */
import { AssetStore } from "@vengine/storage";
import type { StylePack } from "@vengine/shared";
import { ensureAssets, getJson, login, putJson, REMOTE_URL } from "./remote-client.js";

/** The four original dark-deco environment anchors (seed-batman.ts) — kept first. */
const ORIGINAL_ANCHORS = [
  "1e01328b58904796da3af4a33e681c8524575ddd3c2ed0d007ba4d2024e3e5b6", // deco cityscape
  "0473c5d985014ba8569522625139dbb0dd9160a1b8c79dc9a7a40792372f90ff", // deco boardroom
  "2d5dd64f873eaf25ecebeedf17a1452417a68f2f93b0a9f4f0fc012f40921fdd", // dark alley
  "6902877c1cfe9afaf86cd962bd96d398de21c9bae0a45081091ce952e19d2ed0", // java/gas night street
];

/** Verified production-cel extensions (see header for what each one teaches). */
const NEW_ANCHORS = [
  "4150e8eec5fa56a1770ab09dab7b55cb09034bf8245ccd530e055857bd59ec28", // red-sun silhouette two-shot
  "9fa8b8eeef876684da9100fc036db30881adf55c39cc9c01655b0bfbaad56887", // GCPD deco cityscape + bat-signal
  "a7a3760685a55fc1d52c43a7e31b384af784aa75d048ea093eb0c57b8202c1bb", // Mr. Freeze face-off (cold blue)
  "b79346537743e77679b87226e5caa7f7d3ea7847294472136c6e215dfd4df982", // lightning rooftop low-angle
  "4fa0ae756831892e3701b21b035769358976a7bd35d25b3f40f9ec7461bc5b40", // Joker with card on black
  "b9abdb0130a4efaa7f1acc30e27bea53f3a35cea1219a343920b365a445f0338", // Batman grabs the Joker (action)
  "9eb1a8789bcabe13745aa824430d5655648fa15cbe61a384c03d0f27d3abe9fa", // alley rim-lit back shot
  "f3314ff4ed388b4733bb77fe11bc12d851f4e786f713bee2f7bd4d85d661fc1d", // burnt-orange dusk skyline
  "d51bd4482a8d97eb1d27eef9da0587344a363f0dd4a90e0989cb07735c0c7cd6", // Joker extreme close-up
  "cea38d6dbb94d4d46c6f7b285c06ec10dc2d81b80c2cc2d3a4d920df8e7ac634", // warm interior confrontation
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

  // Original four lead (strongest), then everything the pack already carries
  // (hand-added anchors preserved, in order), then the new set.
  const merged: { hash: string; weight: number }[] = [];
  for (const hash of [...ORIGINAL_ANCHORS, ...existing.map((a) => a.hash), ...NEW_ANCHORS]) {
    if (!merged.some((a) => a.hash === hash)) merged.push({ hash, weight: 1 });
  }
  const added = merged.length - existing.length;
  if (added <= 0) {
    console.log(`  nothing to add — pack already carries all ${NEW_ANCHORS.length} extensions`);
  }

  const local = new AssetStore();
  await ensureAssets(merged.map((a) => a.hash), local, "reference image");

  await putJson("/api/library/styles", { ...pack, anchors: merged });
  console.log(`  ✓ “${pack.name}”: ${existing.length} → ${merged.length} anchors (+${Math.max(added, 0)})`);
  console.log("\nDone — every new frame in the universe now draws on the full BTAS look.");
}

main().catch((err) => {
  console.error("seed-btas-anchors failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
