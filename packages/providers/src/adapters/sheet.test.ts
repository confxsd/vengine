import { describe, it, expect } from "vitest";
import { segmentRegions, clampBox, type Box } from "./sheet.js";

/** Paint a filled rectangle into a row-major binary mask. */
function fill(mask: Uint8Array, width: number, box: Box): void {
  for (let y = box.y; y < box.y + box.h; y++) {
    for (let x = box.x; x < box.x + box.w; x++) mask[y * width + x] = 1;
  }
}

/** Sort boxes into a stable order for comparison. */
const order = (boxes: Box[]) => [...boxes].sort((a, b) => a.y - b.y || a.x - b.x);

describe("segmentRegions (projection-profile sheet splitter)", () => {
  it("splits a 2×2 grid of figures separated by whitespace gutters", () => {
    const W = 200;
    const H = 200;
    const mask = new Uint8Array(W * H);
    // Four 60×60 blocks with wide gutters between them.
    const blocks: Box[] = [
      { x: 20, y: 20, w: 60, h: 60 },
      { x: 120, y: 20, w: 60, h: 60 },
      { x: 20, y: 120, w: 60, h: 60 },
      { x: 120, y: 120, w: 60, h: 60 },
    ];
    blocks.forEach((b) => fill(mask, W, b));

    const got = order(segmentRegions(mask, W, H));
    expect(got).toHaveLength(4);
    // Tight boxes recover each block exactly (last ink pixel is inclusive → +1 size).
    got.forEach((b, i) => {
      expect(b.x).toBe(blocks[i]!.x);
      expect(b.y).toBe(blocks[i]!.y);
      expect(b.w).toBe(blocks[i]!.w);
      expect(b.h).toBe(blocks[i]!.h);
    });
  });

  it("keeps a single figure whole when an internal gap is smaller than a gutter", () => {
    const W = 200;
    const H = 200;
    const mask = new Uint8Array(W * H);
    // Two halves of one figure with only a 3px internal gap (< gutter) → one box.
    fill(mask, W, { x: 40, y: 40, w: 50, h: 30 });
    fill(mask, W, { x: 40, y: 73, w: 50, h: 30 }); // 3px gap at y=70..72

    const got = segmentRegions(mask, W, H);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ x: 40, y: 40, w: 50 });
    expect(got[0]!.h).toBe(63); // spans both halves across the bridged gap
  });

  it("separates rows that are split by a tall whitespace band", () => {
    const W = 240;
    const H = 240;
    const mask = new Uint8Array(W * H);
    // A top band with two cells and a bottom band with one — three regions total.
    fill(mask, W, { x: 20, y: 20, w: 40, h: 50 });
    fill(mask, W, { x: 120, y: 20, w: 40, h: 50 });
    fill(mask, W, { x: 60, y: 150, w: 80, h: 50 });

    const got = order(segmentRegions(mask, W, H));
    expect(got).toHaveLength(3);
    expect(got[2]).toMatchObject({ x: 60, y: 150, w: 80, h: 50 });
  });

  it("drops fragments below the minimum box size (speckle / stray marks)", () => {
    const W = 200;
    const H = 200;
    const mask = new Uint8Array(W * H);
    fill(mask, W, { x: 40, y: 40, w: 60, h: 60 }); // a real figure
    fill(mask, W, { x: 150, y: 150, w: 3, h: 3 }); // a speck, well under minBox

    const got = segmentRegions(mask, W, H);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ x: 40, y: 40 });
  });

  it("returns nothing for an empty (all-background) mask", () => {
    expect(segmentRegions(new Uint8Array(100 * 100), 100, 100)).toEqual([]);
  });
});

describe("clampBox", () => {
  it("clamps a box that overflows the image bounds", () => {
    expect(clampBox({ x: 90, y: 90, w: 40, h: 40 }, 100, 100)).toEqual({ x: 90, y: 90, w: 10, h: 10 });
  });
  it("returns null when a box lies fully outside", () => {
    expect(clampBox({ x: 100, y: 100, w: 10, h: 10 }, 100, 100)).toBeNull();
  });
});
