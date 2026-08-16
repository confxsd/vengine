/**
 * Pure-JS image dimension sniffing — enough for asset metadata on Cloudflare
 * Workers (sharp/libvips is a native Node addon and cannot run there).
 * Reads only headers, so cost is O(header) regardless of image size.
 */

const T = new TextDecoder();

function be16(b: Uint8Array, o: number): number {
  return (b[o]! << 8) | b[o + 1]!;
}
function be32(b: Uint8Array, o: number): number {
  return ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
}
function le16(b: Uint8Array, o: number): number {
  return b[o]! | (b[o + 1]! << 8);
}

function sizePng(b: Uint8Array): { width: number; height: number } | undefined {
  if (b.length < 24) return undefined;
  return { width: be32(b, 16), height: be32(b, 20) };
}

function sizeGif(b: Uint8Array): { width: number; height: number } | undefined {
  if (b.length < 10) return undefined;
  return { width: le16(b, 6), height: le16(b, 8) };
}

function sizeJpeg(b: Uint8Array): { width: number; height: number } | undefined {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = b[i + 1]!;
    // SOF0..SOF15 (except DHT/JPG/RST/EOI ranges) carry height/width.
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    ) {
      return { width: be16(b, i + 7), height: be16(b, i + 5) };
    }
    const length = be16(b, i + 2);
    i += 2 + length;
  }
  return undefined;
}

function sizeWebp(b: Uint8Array): { width: number; height: number } | undefined {
  // RIFF....WEBP then the chunk fourcc at offset 12.
  const fourcc = b.length >= 16 ? T.decode(b.subarray(12, 16)) : "";
  if (fourcc === "VP8 " && b.length >= 30) {
    return {
      width: le16(b, 26) & 0x3fff,
      height: le16(b, 28) & 0x3fff,
    };
  }
  if (fourcc === "VP8L" && b.length >= 25) {
    const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (fourcc === "VP8X" && b.length >= 30) {
    const w = (b[24]! | (b[25]! << 8) | (b[26]! << 16)) + 1;
    const h = (b[27]! | (b[28]! << 8) | (b[29]! << 16)) + 1;
    return { width: w, height: h };
  }
  return undefined;
}

function sizeSvg(b: Uint8Array): { width: number; height: number } | undefined {
  const head = T.decode(b.subarray(0, Math.min(b.length, 4096)));
  const m = /<svg[^>]*>/.exec(head);
  if (!m) return undefined;
  const tag = m[0];
  const num = (re: RegExp): number | undefined => {
    const found = re.exec(tag);
    if (!found) return undefined;
    const v = parseFloat(found[1]!);
    return Number.isFinite(v) && v > 0 ? Math.round(v) : undefined;
  };
  const width = num(/\bwidth=["']([\d.]+)/) ?? num(/viewBox=["'][\d.]+\s+[\d.]+\s+([\d.]+)\s+([\d.]+)/);
  const height = num(/\bheight=["']([\d.]+)/) ?? num(/viewBox=["'][\d.]+\s+[\d.]+\s+[\d.]+\s+([\d.]+)/);
  return width && height ? { width, height } : undefined;
}

/** Best-effort { width, height } from an image's header bytes. */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50) return sizePng(bytes);
  if (bytes.length >= 6) {
    const head = T.decode(bytes.subarray(0, 6));
    if (head === "GIF87a" || head === "GIF89a") return sizeGif(bytes);
  }
  if (bytes.length >= 12 && be32(bytes, 0) === 0x52494646 && be32(bytes, 8) === 0x57454250) {
    return sizeWebp(bytes);
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return sizeJpeg(bytes);
  }
  if (bytes.length >= 4 && T.decode(bytes.subarray(0, 4)) === "<svg") return sizeSvg(bytes);
  return undefined;
}

/** sha256 of bytes, hex-encoded — WebCrypto, available in Node 18+ and Workers. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as ArrayBufferView | ArrayBuffer);
  return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
