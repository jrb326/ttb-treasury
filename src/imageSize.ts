/**
 * Label-image dimensions from encoded bytes — no decoders, no canvas:
 * read the format's header fields directly (PNG IHDR, JPEG SOF, WebP chunks).
 *
 * Why: the reserve booking in src/budget.ts must scale with image size.
 * A 4032x3024 phone photo tokenizes an order of magnitude above an 800x1100
 * fixture; a flat per-label reserve would under-book against Cloudflare's
 * hard 10k-neuron account stop. Dimensions are exact from the header bytes —
 * slicing a small base64 window and reading fixed-offset fields, no decoder.
 */

export interface Dimensions {
  width: number;
  height: number;
}

/** Strip `data:<mime>;base64,` prefix → base64 payload (or the input itself). */
export function stripDataUri(s: string): string {
  const comma = s.indexOf(",");
  return s.slice(0, 5) === "data:" && comma !== -1 ? s.slice(comma + 1) : s;
}

/** Header bytes of a base64 image data-URI. cap ≈ 96 KiB raw — enough to
 *  contain SOF even after EXIF/ICC APP segments; PNG/WebP headers are tiny. */
function headerBytes(dataUri: string, cap = 96 * 1024): Uint8Array | null {
  const b64 = stripDataUri(dataUri);
  let bin: string;
  try {
    // Slice FIRST, decode second: never materialize an 8 MB blob just to
    // read a 24-byte header. Base64 is 4/3, and slicing mid-quantum is safe:
    // drop to a multiple of 4 so atob never throws on a partial group.
    const take = Math.min(b64.length, Math.ceil((cap * 4) / 3) & ~3);
    bin = atob(b64.slice(0, take));
  } catch {
    return null; // not base64 / unsupported payload → caller falls back
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const u32be = (b: Uint8Array, o: number) =>
  ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const u16be = (b: Uint8Array, o: number) => (b[o] << 8) | b[o + 1];
const u24le = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);

function png(b: Uint8Array): Dimensions | null {
  if (b.length < 24) return null;
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) if (b[i] !== sig[i]) return null;
  if (String.fromCharCode(b[12], b[13], b[14], b[15]) !== "IHDR") return null;
  const width = u32be(b, 16);
  const height = u32be(b, 20);
  return width > 0 && height > 0 ? { width, height } : null;
}

/** JPEG: skip marker segments until a SOFx (frame header) → width/height. */
function jpeg(b: Uint8Array): Dimensions | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let pos = 2;
  while (pos + 4 <= b.length) {
    if (b[pos] !== 0xff) { pos++; continue; }
    while (pos < b.length && b[pos] === 0xff) pos++; // fill bytes
    if (pos >= b.length) break;
    const marker = b[pos++];
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue; // no length
    if (marker === 0xd9 || marker === 0xda) return null;               // EOI / SOS first: bail
    const segLen = u16be(b, pos);
    if (segLen < 2 || pos + segLen > b.length) return null;             // truncated header window
    const isSOF =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSOF) {
      const height = u16be(b, pos + 3);
      const width = u16be(b, pos + 5);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    pos += segLen;
  }
  return null;
}

/** WebP: RIFF container → VP8 (lossy frame), VP8L (lossless), VP8X (canvas). */
function webp(b: Uint8Array): Dimensions | null {
  if (b.length < 30) return null;
  const tag = (o: number) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  if (tag(0) !== "RIFF" || tag(8) !== "WEBP") return null;
  const kind = tag(12);
  if (kind === "VP8 ") {
    // key-frame: 3-byte frame tag, 3-byte start code 9d 01 2a, then 14-bit dims
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { width: (b[26] | (b[27] << 8)) & 0x3fff, height: (b[28] | (b[29] << 8)) & 0x3fff };
  }
  if (kind === "VP8L") {
    if (b[20] !== 0x2f) return null;
    const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >> 14) & 0x3fff) + 1;
    return { width, height };
  }
  if (kind === "VP8X") {
    return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
  }
  return null;
}

/**
 * Dimensions of a base64 label photo (raw base64 or data-URI).
 * null = unknown format / header window too short — the caller must not
 * pretend it knows: budget.ts falls back to the flat per-label reserve.
 */
export function parseImageDimensions(dataUri: string): Dimensions | null {
  const b = headerBytes(dataUri);
  if (!b) return null;
  return png(b) ?? jpeg(b) ?? webp(b);
}