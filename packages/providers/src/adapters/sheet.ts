/**
 * Character-sheet ingestion: split one combined reference sheet (turnaround +
 * expressions + gesture poses + palette + text, the kind an image model produces) into
 * clean, single-subject crops that make strong identity references.
 *
 * Feeding a whole sheet to a reference-conditioned model yields a generic subject — it
 * can't read fine identity from ~25 thumbnail-sized figures on one canvas. So we slice
 * it. Rather than hard-code one layout, we segment by **projection profiles**: a sheet
 * lays its cells out in rows and columns separated by whitespace gutters, so summing
 * "ink" (non-background pixels) per row finds the horizontal bands, and per column
 * within each band finds the cells. This is layout-agnostic (any grid-ish sheet) and
 * deterministic/free — no model call. Detection is deliberately permissive; a human
 * picks which crops to keep (text blocks, palette swatches and call-outs are proposed
 * too, and simply deselected), which is far more robust than fragile full-auto.
 *
 * `segmentRegions` is the pure algorithm (raw mask in, boxes out) and is unit-tested;
 * `analyzeSheet`/`cropRegion`/`cropPreview` are the sharp-backed wrappers.
 */
import sharp from "sharp";

/** A crop rectangle in **full-resolution sheet pixels**. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A proposed crop plus a heuristic hint of whether it looks like a character pose
 *  (tall-ish, mid-sized) vs. a text block / palette swatch — drives default selection. */
export interface SheetRegion {
  box: Box;
  suggested: boolean;
}

/** Longest side of the raster we analyze. Downscaling denoises and bounds the cost of
 *  the per-pixel projection scan; boxes are mapped back to full resolution after. */
const ANALYSIS_MAX = 1200;
/** A pixel is "ink" when its grayscale value differs from the sheet background by more
 *  than this (0..255). Catches dark line-art and shading; ignores faint anti-aliasing
 *  and near-white fills — enough to bound each figure by its outline. */
const BG_TOLERANCE = 36;
/** A whitespace run this fraction of the short side (or longer) separates two cells;
 *  shorter gaps are bridged, so a figure split by a thin internal gap stays one box.
 *  Tuned so a tightly-packed turnaround row still splits into individual figures while
 *  a single figure's internal gaps (between ears, paws) don't fracture it. */
const GAP_FRAC = 0.012;
/** A row/column counts as "content" when its ink fraction exceeds this — filters stray
 *  speckle so a single dust pixel doesn't extend a band/cell. */
const MIN_LINE_INK_FRAC = 0.012;
/** Drop a crop whose shorter side is below this fraction of the sheet's short side —
 *  removes tiny fragments (stray glyphs, rule marks). */
const MIN_BOX_FRAC = 0.045;
/** Grow each tight crop outward by this fraction of the short side, so a figure keeps a
 *  little breathing room instead of being shaved at the outline. */
const PAD_FRAC = 0.012;
/** Hard cap on proposed regions (a pathological sheet shouldn't flood the UI/cost). */
const MAX_REGIONS = 48;

/** Default output crop: long side, JPEG quality. 768px is plenty for an identity ref
 *  and keeps the asset small; flattened onto white so transparency doesn't go black. */
const OUTPUT_MAX = 768;
const OUTPUT_QUALITY = 92;
/** Small, cheap preview returned inline (data URI) for the selection grid. */
const PREVIEW_MAX = 240;
const PREVIEW_QUALITY = 70;

export interface SegmentOpts {
  gapFrac?: number;
  minLineInkFrac?: number;
  minBoxFrac?: number;
}

/**
 * Contiguous `[start, end)` index runs (within `[lo, hi)`) where `active[i]` is true,
 * merging two runs separated by a gap shorter than `minGap` (so a hairline split inside
 * one figure doesn't fracture it). Also reports the widest separating gap, which XY-cut
 * uses to decide which axis to split first.
 */
function profile(
  active: boolean[],
  lo: number,
  hi: number,
  minGap: number,
): { runs: Array<[number, number]>; maxGap: number } {
  const raw: Array<[number, number]> = [];
  let start = -1;
  for (let i = lo; i < hi; i++) {
    if (active[i]) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      raw.push([start, i]);
      start = -1;
    }
  }
  if (start >= 0) raw.push([start, hi]);

  const runs: Array<[number, number]> = [];
  let maxGap = 0;
  for (const run of raw) {
    const last = runs[runs.length - 1];
    if (last) {
      const gap = run[0] - last[1];
      if (gap < minGap) {
        last[1] = run[1];
        continue;
      }
      if (gap > maxGap) maxGap = gap;
    }
    runs.push([run[0], run[1]]);
  }
  return { runs, maxGap };
}

/** The tight bounding box of ink within `[x0,x1) × [y0,y1)`, or null if the cell is
 *  empty (all background). Trims the surrounding whitespace a cell's gutters left in. */
function tighten(
  mask: Uint8Array,
  width: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): Box | null {
  let minX = x1;
  let minY = y1;
  let maxX = x0 - 1;
  let maxY = y0 - 1;
  for (let y = y0; y < y1; y++) {
    const off = y * width;
    for (let x = x0; x < x1; x++) {
      if (mask[off + x]) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < minX || maxY < minY) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/** Row/column "active" (carries enough ink to be content) profiles for the sub-rect
 *  `[x0,x1) × [y0,y1)`, computed only over that window. */
function windowProfiles(
  mask: Uint8Array,
  width: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  inkFrac: number,
): { rowActive: boolean[]; colActive: boolean[] } {
  const minRowInk = Math.max(1, Math.round(inkFrac * (x1 - x0)));
  const minColInk = Math.max(1, Math.round(inkFrac * (y1 - y0)));
  const rowActive = new Array<boolean>(y1).fill(false);
  const colCount = new Array<number>(x1).fill(0);
  for (let y = y0; y < y1; y++) {
    const off = y * width;
    let rc = 0;
    for (let x = x0; x < x1; x++) {
      if (mask[off + x]) {
        rc++;
        colCount[x] = colCount[x]! + 1;
      }
    }
    rowActive[y] = rc >= minRowInk;
  }
  const colActive = new Array<boolean>(x1).fill(false);
  for (let x = x0; x < x1; x++) colActive[x] = colCount[x]! >= minColInk;
  return { rowActive, colActive };
}

/**
 * Pure **recursive XY-cut** segmentation. `mask` is a `width*height` row-major binary
 * raster (1 = ink). At each step it cuts the region along the axis with the widest
 * whitespace gutter and recurses into each piece, so nested layouts split correctly
 * (e.g. a tall info column beside a multi-row grid of figures — a single row-then-column
 * pass can't separate those, but alternating cuts can). Leaves are tightened to their
 * ink and returned in reading order. No image library — unit-testable on synthetic masks.
 */
export function segmentRegions(
  mask: Uint8Array,
  width: number,
  height: number,
  opts: SegmentOpts = {},
): Box[] {
  const minDim = Math.min(width, height);
  const minGap = Math.max(4, Math.round((opts.gapFrac ?? GAP_FRAC) * minDim));
  const inkFrac = opts.minLineInkFrac ?? MIN_LINE_INK_FRAC;
  const minBox = Math.max(2, Math.round((opts.minBoxFrac ?? MIN_BOX_FRAC) * minDim));

  const boxes: Box[] = [];
  const cut = (x0: number, y0: number, x1: number, y1: number, depth: number): void => {
    if (x1 - x0 < 1 || y1 - y0 < 1) return;
    const { rowActive, colActive } = windowProfiles(mask, width, x0, y0, x1, y1, inkFrac);
    const rows = profile(rowActive, y0, y1, minGap);
    const cols = profile(colActive, x0, x1, minGap);

    // A leaf: neither axis has a usable gutter (or we've recursed deep enough). Tighten
    // to the contained ink and keep it if it clears the minimum-size floor.
    const canCutRows = rows.runs.length > 1;
    const canCutCols = cols.runs.length > 1;
    if (depth >= 12 || (!canCutRows && !canCutCols)) {
      const box = tighten(mask, width, x0, y0, x1, y1);
      if (box && box.w >= minBox && box.h >= minBox) boxes.push(box);
      return;
    }

    // Cut along the axis whose widest gutter is larger (ties → prefer columns, which
    // tends to peel a side panel off a grid before slicing the grid into rows).
    if (canCutCols && (!canCutRows || cols.maxGap >= rows.maxGap)) {
      for (const [cx0, cx1] of cols.runs) cut(cx0, y0, cx1, y1, depth + 1);
    } else {
      for (const [ry0, ry1] of rows.runs) cut(x0, ry0, x1, ry1, depth + 1);
    }
  };
  cut(0, 0, width, height, 0);

  return boxes.sort((a, b) => a.y - b.y || a.x - b.x);
}

/** Median grayscale of border pixels — the sheet's background (white, usually, but we
 *  measure rather than assume so off-white/tinted sheets still segment). */
function estimateBackground(data: Uint8Array | Buffer, width: number, height: number): number {
  const samples: number[] = [];
  const stepX = Math.max(1, Math.floor(width / 64));
  const stepY = Math.max(1, Math.floor(height / 64));
  for (let x = 0; x < width; x += stepX) {
    samples.push(data[x]!, data[(height - 1) * width + x]!);
  }
  for (let y = 0; y < height; y += stepY) {
    samples.push(data[y * width]!, data[y * width + width - 1]!);
  }
  samples.sort((a, b) => a - b);
  return samples[samples.length >> 1] ?? 255;
}

/** Heuristic: does a box look like a single character pose (so it should be selected
 *  by default) rather than a wide text row, a thin rule, or the whole sheet? */
function isLikelyPose(box: Box, W: number, H: number): boolean {
  const areaFrac = (box.w * box.h) / (W * H);
  const aspect = box.h / box.w; // figures are usually as-tall-or-taller than wide
  return aspect >= 0.55 && aspect <= 3.4 && areaFrac >= 0.004 && areaFrac <= 0.32;
}

/** Intersect a box with the image bounds, returning null if there's no positive-area
 *  overlap (so a box entirely off-canvas is rejected, not pinned to a 1px edge sliver). */
export function clampBox(box: Box, W: number, H: number): Box | null {
  const x0 = Math.max(0, Math.round(box.x));
  const y0 = Math.max(0, Math.round(box.y));
  const x1 = Math.min(Math.round(box.x + box.w), W);
  const y1 = Math.min(Math.round(box.y + box.h), H);
  const w = x1 - x0;
  const h = y1 - y0;
  if (w < 1 || h < 1) return null;
  return { x: x0, y: y0, w, h };
}

/**
 * Analyze a sheet image: detect candidate crop regions in full-resolution pixel space,
 * each flagged `suggested` if it looks like a pose. Downscales to `ANALYSIS_MAX` for the
 * projection scan, then maps boxes back up and pads them.
 */
export async function analyzeSheet(
  bytes: Uint8Array,
  opts: SegmentOpts = {},
): Promise<{ width: number; height: number; regions: SheetRegion[] }> {
  const meta = await sharp(bytes).rotate().metadata();
  const W = meta.width ?? 0;
  const H = meta.height ?? 0;
  if (!W || !H) throw new Error("Could not read sheet image dimensions");

  const scale = Math.min(1, ANALYSIS_MAX / Math.max(W, H));
  const aw = Math.max(1, Math.round(W * scale));
  const ah = Math.max(1, Math.round(H * scale));
  const { data } = await sharp(bytes)
    .rotate()
    .removeAlpha()
    .grayscale()
    .resize(aw, ah, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const bg = estimateBackground(data, aw, ah);
  const mask = new Uint8Array(aw * ah);
  for (let i = 0; i < mask.length; i++) mask[i] = Math.abs(data[i]! - bg) > BG_TOLERANCE ? 1 : 0;

  const inv = 1 / scale;
  const pad = Math.round(PAD_FRAC * Math.min(W, H));
  const regions: SheetRegion[] = [];
  for (const b of segmentRegions(mask, aw, ah, opts)) {
    const full = clampBox(
      { x: b.x * inv - pad, y: b.y * inv - pad, w: b.w * inv + 2 * pad, h: b.h * inv + 2 * pad },
      W,
      H,
    );
    if (full) regions.push({ box: full, suggested: isLikelyPose(full, W, H) });
  }
  regions.sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
  return { width: W, height: H, regions: regions.slice(0, MAX_REGIONS) };
}

/** Extract + downscale one region to a white-matted JPEG identity reference. Clamps the
 *  box to the image; throws if it doesn't overlap (the caller validates user boxes). */
export async function cropRegion(
  bytes: Uint8Array,
  box: Box,
  opts: { maxSize?: number; quality?: number } = {},
): Promise<Uint8Array> {
  const meta = await sharp(bytes).rotate().metadata();
  const clamped = clampBox(box, meta.width ?? 0, meta.height ?? 0);
  if (!clamped) throw new Error("crop box is outside the image");
  const size = opts.maxSize ?? OUTPUT_MAX;
  const out = await sharp(bytes)
    .rotate()
    .extract({ left: clamped.x, top: clamped.y, width: clamped.w, height: clamped.h })
    .resize({ width: size, height: size, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: opts.quality ?? OUTPUT_QUALITY })
    .toBuffer();
  return new Uint8Array(out);
}

/** A small inline `data:` preview of a region for the selection UI. */
export async function cropPreview(bytes: Uint8Array, box: Box): Promise<string> {
  const out = await cropRegion(bytes, box, { maxSize: PREVIEW_MAX, quality: PREVIEW_QUALITY });
  return `data:image/jpeg;base64,${Buffer.from(out).toString("base64")}`;
}
