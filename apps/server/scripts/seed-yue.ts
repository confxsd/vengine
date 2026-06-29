/**
 * Seed the recurring character **Yue** (exiled moon-goddess in rabbit form) into the
 * cross-project Library from her professional reference sheet.
 *
 * It crops the top *turnaround* band (FRONT · 3/4 · SIDE · BACK · 3/4-BACK) into clean,
 * single-pose identity references — feeding the whole collage to a model just yields a
 * grid of rabbits, so we slice it — banks each into the asset store, and creates the
 * Yue character with her palette (hex codes = a text identity lock alongside the
 * images) and description. Idempotent: re-running replaces Yue in place.
 *
 *   pnpm --filter @vengine/server seed:yue ["/path/to/sheet.png"]
 *
 * The crop fractions below are tuned for this sheet's layout — tweak if your sheet
 * frames the turnaround differently.
 */
import { homedir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { AssetStore, LibraryStore } from "@vengine/storage";

const DEFAULT_SHEET = path.join(homedir(), "Downloads", "ChatGPT Image Jun 29, 2026, 03_27_56 PM.png");

/** Turnaround band as fractions of the sheet (x0..x1 horizontally, y0..y1 vertically),
 *  split into `cols` equal pose columns. The left info panel and the expression studies
 *  sit outside this band. */
const BAND = { x0: 0.16, x1: 0.64, y0: 0.04, y1: 0.46, cols: 5 };
const POSES = ["front", "three-quarter-front", "side", "back", "three-quarter-back"];

const YUE = {
  id: "yue",
  name: "Yue",
  description:
    "Yue — an exiled moon-goddess in rabbit form (a lunar Moon Rabbit). A small white rabbit, " +
    "~38cm tall, with long, very mobile and expressive ears (soft pale-pink inner fur, light-gray " +
    "outer rim); almond-shaped hooded eyes with a tired, intelligent lunar gaze (lilac iris); small " +
    "narrow forepaws. Dry, witty, sarcastic and rebellious, yet secretly tender.",
  // Palette from the sheet's call-outs — text identity lock alongside the image refs.
  palette: [
    "fur #F4F2F0",
    "fur shadow #E6E2DE",
    "cool shadow #D8D6DC",
    "inner ear #F2C7C2",
    "nose #E7B6B2",
    "eye iris #B6B7D6",
    "eye rim #6E6F86",
    "paw pads #D8C2C2",
    "fur accent #BEB8B0",
    "line #4A484A",
  ],
  tags: ["recurring", "rabbit", "lunar"],
};

async function main() {
  const sheetPath = process.argv[2] ?? DEFAULT_SHEET;
  const assets = new AssetStore();
  const library = new LibraryStore();

  const img = sharp(sheetPath);
  const meta = await img.metadata();
  const W = meta.width;
  const H = meta.height;
  if (!W || !H) throw new Error(`Could not read image dimensions for ${sheetPath}`);

  const top = Math.round(BAND.y0 * H);
  const bandH = Math.round((BAND.y1 - BAND.y0) * H);
  const bandX0 = BAND.x0 * W;
  const colW = ((BAND.x1 - BAND.x0) * W) / BAND.cols;

  const refHashes: string[] = [];
  for (let i = 0; i < BAND.cols; i++) {
    const left = Math.round(bandX0 + i * colW);
    const width = Math.round(colW);
    // Re-read the source per crop (sharp instances are single-use after a pipeline).
    const buf = await sharp(sheetPath)
      .extract({ left, top, width, height: bandH })
      .resize({ width: 768, height: 768, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 92 })
      .toBuffer();
    const ref = await assets.put(new Uint8Array(buf), "image/jpeg");
    refHashes.push(ref.hash);
    console.log(`  ✓ ${POSES[i] ?? `pose-${i}`} → ${ref.hash.slice(0, 12)}…`);
  }

  const saved = await library.upsertCharacter({
    ...YUE,
    refHashes,
    loraId: undefined,
  } as Parameters<LibraryStore["upsertCharacter"]>[0]);

  console.log(`\n✓ Seeded "${saved.name}" with ${refHashes.length} references into the Library.`);
  console.log("  Open the Library panel → Characters → Yue, then hit “Train LoRA”.");
}

main().catch((err) => {
  console.error("seed-yue failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
