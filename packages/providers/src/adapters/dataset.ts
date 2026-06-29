import sharp from "sharp";
import type { TrainingExample } from "../types.js";

/**
 * Packs a LoRA training dataset into a single `data:` URI that fal's trainers
 * accept in their `*_data_url` field — no fal-storage round-trip, no zip dependency.
 *
 * fal wants a ZIP of images (+ optional same-named `.txt` captions). Datasets are
 * small (10–30 images for a character), and we downscale them first, so the whole
 * archive comfortably fits an inline base64 URI. For very large style datasets,
 * fal-storage upload is the follow-up (see ENGINEERING §18); this keeps v1 simple
 * and dependency-free.
 */

/** Max long-edge px we re-encode dataset images to. ~1MP is plenty for LoRA and keeps
 *  the inline archive small; larger inputs only slow training and bloat the data URI. */
const MAX_EDGE = 1024;
const JPEG_QUALITY = 90;
/** Soft ceiling on the base64 archive; beyond this fal-storage upload is the right tool. */
const MAX_DATA_URI_BYTES = 12 * 1024 * 1024;

/** Zero-pad an index to a stable, sortable file stem (0001, 0002, …). */
function stem(i: number): string {
  return String(i + 1).padStart(4, "0");
}

/** CRC-32 (IEEE 802.3) — required by the ZIP local/central headers. Table built once. */
const CRC_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!)! & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

interface ZipEntry {
  name: string;
  data: Uint8Array;
}

/**
 * Build a minimal **store-only** (uncompressed) ZIP — local file headers + central
 * directory + end-of-central-directory. Stored entries need no deflate, so this is
 * a few dozen lines and has no dependency; trainers only need a readable archive,
 * not a small one (we already downscaled). All multi-byte fields are little-endian.
 */
function buildZip(entries: ZipEntry[]): Uint8Array {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const e of entries) {
    const nameBytes = enc.encode(e.name);
    const crc = crc32(e.data);
    const size = e.data.length;

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); // local file header signature
    local.setUint16(4, 20, true); // version needed
    local.setUint16(6, 0, true); // flags
    local.setUint16(8, 0, true); // method 0 = stored
    local.setUint16(10, 0, true); // mod time
    local.setUint16(12, 0, true); // mod date
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true); // compressed size
    local.setUint32(22, size, true); // uncompressed size
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true); // extra length
    const localHeader = new Uint8Array(local.buffer);
    locals.push(localHeader, nameBytes, e.data);

    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true); // central directory header signature
    central.setUint16(4, 20, true); // version made by
    central.setUint16(6, 20, true); // version needed
    central.setUint16(8, 0, true); // flags
    central.setUint16(10, 0, true); // method
    central.setUint16(12, 0, true); // mod time
    central.setUint16(14, 0, true); // mod date
    central.setUint32(16, crc, true);
    central.setUint32(20, size, true);
    central.setUint32(24, size, true);
    central.setUint16(28, nameBytes.length, true);
    central.setUint16(30, 0, true); // extra length
    central.setUint16(32, 0, true); // comment length
    central.setUint16(34, 0, true); // disk number
    central.setUint16(36, 0, true); // internal attrs
    central.setUint32(38, 0, true); // external attrs
    central.setUint32(42, offset, true); // local header offset
    centrals.push(new Uint8Array(central.buffer), nameBytes);

    offset += localHeader.length + nameBytes.length + e.data.length;
  }

  const centralStart = offset;
  const centralBytes = concat(centrals);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true); // end of central directory signature
  eocd.setUint16(4, 0, true); // disk number
  eocd.setUint16(6, 0, true); // central dir disk
  eocd.setUint16(8, entries.length, true); // entries on this disk
  eocd.setUint16(10, entries.length, true); // total entries
  eocd.setUint32(12, centralBytes.length, true); // central dir size
  eocd.setUint32(16, centralStart, true); // central dir offset
  eocd.setUint16(20, 0, true); // comment length

  return concat([...locals, centralBytes, new Uint8Array(eocd.buffer)]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * Downscale + re-encode a training image to a bounded JPEG. `withoutEnlargement`
 * keeps small inputs untouched; `flatten` drops alpha onto white so JPEG (no alpha)
 * doesn't blacken transparent reference-sheet crops.
 */
async function normalizeImage(bytes: Uint8Array): Promise<Uint8Array> {
  const out = await sharp(Buffer.from(bytes))
    .rotate() // honor EXIF orientation before stripping metadata
    .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: JPEG_QUALITY })
    .toBuffer();
  return new Uint8Array(out);
}

/**
 * Build the inline dataset archive for a training run. Returns a `data:` URI plus
 * the encoded byte size (so callers can warn / fall back before submitting a 50MB
 * body). Each example becomes `NNNN.jpg`, and any caption becomes the same-named
 * `NNNN.txt` — fal's caption convention.
 */
export async function buildDatasetDataUri(
  examples: TrainingExample[],
): Promise<{ dataUri: string; bytes: number }> {
  if (examples.length === 0) throw new Error("Training dataset is empty.");

  const entries: ZipEntry[] = [];
  const enc = new TextEncoder();
  for (let i = 0; i < examples.length; i++) {
    const ex = examples[i]!;
    const img = await normalizeImage(ex.bytes);
    entries.push({ name: `${stem(i)}.jpg`, data: img });
    const caption = ex.caption?.trim();
    if (caption) entries.push({ name: `${stem(i)}.txt`, data: enc.encode(caption) });
  }

  const zip = buildZip(entries);
  const base64 = Buffer.from(zip).toString("base64");
  const dataUri = `data:application/zip;base64,${base64}`;
  if (dataUri.length > MAX_DATA_URI_BYTES) {
    console.warn(
      `fal training dataset is ${(dataUri.length / 1_048_576).toFixed(1)}MB inline — ` +
        `consider fewer/smaller images or fal-storage upload (ENGINEERING §18).`,
    );
  }
  return { dataUri, bytes: dataUri.length };
}

// Exposed for unit tests (zip integrity) without going through sharp.
export const __test = { buildZip, crc32 };
