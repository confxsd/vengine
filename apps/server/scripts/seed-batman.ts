/**
 * Seed **The Batman** universe — the shared visual world your batman stories live
 * in — from the reference images already banked in the local asset store:
 *
 *   - Style pack "The Batman — Animated Noir" (btas-noir): the theme that produced
 *     your existing batman comics, extended with the BTAS look, anchored on the four
 *     confirmed Dark-Deco background paintings, 768×1344, nano-banana-pro.
 *   - Cast: Bruce Wayne/Batman (with the two character-sheet refs), Selina Kyle,
 *     Joker, Alfred — BTAS visual descriptions + aliases so any pasted story maps
 *     its names onto them ("batman", "bruce", "selina"… all resolve).
 *   - Series "The Batman" (the-batman): premise + keywords for auto-detection,
 *     the cast, the style, and your existing `batman` / `the batman 2` projects
 *     linked as episodes.
 *
 * Idempotent (stable ids — re-running upserts in place). Targets the deployed API
 * by default; `--local` targets a running local server instead.
 *
 *   pnpm --filter @vengine/server seed:batman [--local]
 */
import { AssetStore } from "@vengine/storage";
import { ensureAssets, getJson, login, putJson, REMOTE_URL } from "./remote-client.js";
import type { ComicProject } from "@vengine/shared";

/** Confirmed BTAS "Dark Deco" background paintings from your batman projects. */
const STYLE_ANCHORS = [
  "1e01328b58904796da3af4a33e681c8524575ddd3c2ed0d007ba4d2024e3e5b6", // deco cityscape (batman-2 anchor)
  "0473c5d985014ba8569522625139dbb0dd9160a1b8c79dc9a7a40792372f90ff", // deco boardroom (batman-2 anchor)
  "2d5dd64f873eaf25ecebeedf17a1452417a68f2f93b0a9f4f0fc012f40921fdd", // dark alley (batman)
  "6902877c1cfe9afaf86cd962bd96d398de21c9bae0a45081091ce952e19d2ed0", // java/gas night street (batman)
];

/** Confirmed Batman character references (3-panel rooftop sheet + gargoyle pose). */
const BRUCE_REFS = [
  "4c4434c06ff44d6775b377e06d4d33c1357265b1f8dc5b4b75050bb1a2477707",
  "53fbe49ff1c92fd1558aa6ff0ee335989e16ab460ed223a21cf90aded47da291",
];

const NEGATIVE =
  "text, words, letters, typography, watermark, signature, speech bubble, caption, logo, frame border, panel grid, photorealistic, photograph, 3d render";

const STYLE_ID = "btas-noir";
const SERIES_ID = "the-batman";

const THEME =
  "Batman: The Animated Series aesthetic, Bruce Timm animated noir, dark deco, " +
  "contemporary-art comic illustration, bold confident ink linework, flat cel shading, " +
  "dramatic high-contrast chiaroscuro lighting, art-deco Gotham architecture, strong " +
  "silhouettes and clear shapes, limited moody palette of deep blues and blacks with " +
  "selective warm accents, cinematic composition";

const CONCEPT =
  "An episodic noir set in a dark-deco Gotham: self-contained short stories about Bruce " +
  "Wayne / Batman, Selina Kyle, the Joker and Alfred Pennyworth. Melancholic, philosophical, " +
  "existentially playful tone — tales about fear, fate, vanity, loneliness and the stories " +
  "people tell themselves. Stories jump across eras of Bruce's life (teens, early career, " +
  "settled years) but the visual world stays one animated-noir universe.";

const CHARACTERS = [
  {
    id: "batman-bruce",
    name: "Bruce Wayne",
    aliases: ["batman", "bruce", "bruce wayne", "the batman", "the dark knight"],
    refHashes: BRUCE_REFS,
    description:
      "Bruce Wayne — a tall, broad-shouldered man with a strong square jaw, dark slicked-back " +
      "hair and sharp blue eyes under a heavy brow. As Bruce: composed and brooding, sharp dark " +
      "tailored suit. As Batman: sleek grey-and-black Batsuit, long-eared cowl, heavy scalloped " +
      "black cape, yellow utility belt. Early-career stories may show him younger (late teens " +
      "to twenties) — softer face, same intensity.",
    palette: ["suit #232634", "batsuit grey #5a5f6e", "cape & cowl #14161f", "belt #d9a441"],
    tags: ["batman", "recurring", "protagonist"],
  },
  {
    id: "selina-kyle",
    name: "Selina Kyle",
    aliases: ["selina", "catwoman"],
    refHashes: [],
    description:
      "Selina Kyle — a slender, athletic woman with short dark hair (violet sheen), pale violet " +
      "eyes and red lipstick; confident, teasing, independent. Elegant dark evening wear as " +
      "Selina; as Catwoman a sleek black catsuit with white stitching. Older stories may draw " +
      "her with longer wavy dark hair.",
    palette: ["hair #2a2333", "lips #b03a48", "catsuit #17181d", "stitch #e8e6e0"],
    tags: ["batman", "recurring"],
  },
  {
    id: "joker",
    name: "Joker",
    aliases: ["joker", "the joker", "mister j"],
    refHashes: [],
    description:
      "The Joker — lean, theatrical man with chalk-white skin, a sharp chin, dark-green slicked-back " +
      "hair, blood-red lips in a permanent grin, and dark-rimmed piercing eyes. Classic purple " +
      "suit with orange vest and green bow tie; stories may recostume him (e.g. a plain " +
      "businessman's suit) while the face stays unmistakably the Joker.",
    palette: ["skin #f2efe9", "hair #2f4a3d", "lips #b3202c", "suit #4a3a66", "vest #c77b3a"],
    tags: ["batman", "recurring", "antagonist"],
  },
  {
    id: "alfred",
    name: "Alfred Pennyworth",
    aliases: ["alfred", "alfred pennyworth"],
    refHashes: [],
    description:
      "Alfred Pennyworth — Bruce's elderly, slim butler: silver hair, neat mustache, kind tired " +
      "eyes, impeccable posture. Crisp dark suit with tie (white gloves when serving). Dry wit, " +
      "unshakable calm, the quiet moral anchor of Wayne Manor.",
    palette: ["hair #c9c6c0", "suit #26282f", "shirt #e9e7e1", "tie #4a3a2f"],
    tags: ["batman", "recurring"],
  },
];

/** Existing local projects that become episodes of the universe. */
const EPISODES = ["bc1962aa", "dd250269"]; // "batman", "the batman 2"

async function main() {
  if (process.argv.includes("--local")) process.env.SYNC_REMOTE_URL = "http://localhost:5174";
  console.log(`Seeding “The Batman” universe → ${process.env.SYNC_REMOTE_URL ?? REMOTE_URL}`);
  await login();

  const local = new AssetStore();
  await ensureAssets([...STYLE_ANCHORS, ...BRUCE_REFS], local, "reference image");

  // ── Style pack ──────────────────────────────────────────────────────────────
  const pack = {
    id: STYLE_ID,
    name: "The Batman — Animated Noir",
    theme: THEME,
    negative: NEGATIVE,
    width: 768,
    height: 1344,
    recommendedModelId: "fal/nano-banana-pro",
    anchors: STYLE_ANCHORS.map((hash) => ({ hash, weight: 1 })),
    loras: [],
    tags: ["batman", "noir", "animated", "universe"],
    builtIn: false,
  };
  await putJson("/api/library/styles", pack);
  console.log(`  ✓ style pack “${pack.name}” (${STYLE_ANCHORS.length} anchors)`);

  // ── Cast ────────────────────────────────────────────────────────────────────
  for (const c of CHARACTERS) {
    await putJson("/api/library/characters", { ...c, studies: [] });
    console.log(`  ✓ character “${c.name}” (aliases: ${c.aliases.join(", ")})`);
  }

  // ── Series ──────────────────────────────────────────────────────────────────
  const remoteProjects = await getJson<{ id: string }[]>("/api/comics").catch(() => []);
  const remoteIds = new Set(remoteProjects.map((p) => p.id));
  const episodes = EPISODES.filter((id) => remoteIds.has(id));
  const series = {
    id: SERIES_ID,
    name: "The Batman",
    description: "Self-contained noir episodes in one animated Bat-universe.",
    concept: CONCEPT,
    keywords: [
      "batman", "bruce", "wayne", "gotham", "joker", "selina", "catwoman", "alfred",
      "arkham", "wayne manor", "gordon", "dark knight", "pennyworth",
    ],
    projectIds: episodes,
    castIds: CHARACTERS.map((c) => c.id),
    defaultStyleId: STYLE_ID,
  };
  await putJson("/api/library/series", series);
  console.log(`  ✓ series “The Batman” (${episodes.length} linked episode(s))`);

  // Link the existing episodes' documents to the universe (the Studio badge).
  for (const id of episodes) {
    const project = await getJson<ComicProject>(`/api/comics/${id}`);
    if (project.seriesId !== SERIES_ID) {
      await putJson(`/api/comics/${id}`, { ...project, seriesId: SERIES_ID });
      console.log(`  ✓ episode “${project.name}” → universe`);
    }
  }

  console.log("\nDone — paste any batman story and it will auto-join this universe.");
}

main().catch((err) => {
  console.error("seed-batman failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
