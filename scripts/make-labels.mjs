// Generates the 5 test label fixtures (800x1100 PNG) into public/.
// Run: node scripts/make-labels.mjs   (requires sharp)
//
// Labels are built as SVG strings (cream bg, serif, centered blocks) and
// rasterised with sharp. Ground truth for each lives in scripts/expected-results.json.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, "..", "public");

const W = 800;
const H = 1100;

// Canonical 27 CFR part 16 statement (mirrors src/warning.ts).
const WARNING_HEADING = "GOVERNMENT WARNING:";
const WARNING_BODY =
  "(1) According to the Surgeon General, women should not drink alcoholic beverages " +
  "during pregnancy because of the risk of birth defects. (2) Consumption of alcoholic " +
  "beverages impairs your ability to drive a car or operate machinery, and may cause " +
  "health problems.";

/** Escape text for XML. */
function esc(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Naive word wrap by character budget (serif 18px ≈ 8px/char at ~700px box). */
function wrap(text, maxChars) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = "";
  for (const w of words) {
    if (line && (line + " " + w).length > maxChars) {
      lines.push(line);
      line = w;
    } else {
      line = line ? line + " " + w : w;
    }
  }
  if (line) lines.push(line);
  return lines;
}

const CX = W / 2;

/**
 * One centered <text> line.
 * opts: size, weight ("normal"|"700"), extra (raw attrs string), italic, dy via y.
 */
function line(text, y, { size = 32, weight = "normal", extra = "", fill = "#111" } = {}) {
  return `<text x="${CX}" y="${y}" text-anchor="middle" font-size="${size}" font-weight="${weight}" fill="${fill}" ${extra}>${esc(text)}</text>`;
}

/**
 * Build a label SVG.
 * spec: { brand, klass, abv, net, bottler?, warning?: "correct" | "titlecase" | "none" }
 */
function labelSvg(spec) {
  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`);
  parts.push(`<rect width="${W}" height="${H}" fill="#f3ecd9"/>`);
  parts.push(`<rect x="24" y="24" width="${W - 48}" height="${H - 48}" fill="none" stroke="#111" stroke-width="3"/>`);
  parts.push(`<g font-family="serif">`);

  // Brand block
  parts.push(line(spec.brand, 220, { size: 64, weight: "700" }));
  parts.push(`<line x1="180" y1="262" x2="${W - 180}" y2="262" stroke="#111" stroke-width="2"/>`);

  // Class / type
  parts.push(line(spec.klass, 330, { size: 34 }));

  // ABV + net contents
  parts.push(line(spec.abv, 470, { size: 40 }));
  parts.push(line(spec.net, 530, { size: 30 }));

  // Bottler line (optional)
  if (spec.bottler) parts.push(line(spec.bottler, 640, { size: 24, extra: 'font-style="italic"' }));

  // Government warning block, bottom
  if (spec.warning && spec.warning !== "none") {
    const boxY = 830;
    const boxH = 220;
    parts.push(
      `<rect x="60" y="${boxY}" width="${W - 120}" height="${boxH}" fill="#ffffff" stroke="#111" stroke-width="2"/>`
    );
    const titlecase = spec.warning === "titlecase";
    const headingY = boxY + 36;
    if (titlecase) {
      // Deliberate formatting violation: title-case, NOT bold.
      parts.push(
        `<text x="${CX}" y="${headingY}" text-anchor="middle" font-size="18" style="font-weight:normal; text-transform:none" fill="#111">Government Warning:</text>`
      );
    } else {
      parts.push(line(WARNING_HEADING, headingY, { size: 18, weight: "700" }));
    }
    const bodyLines = wrap(WARNING_BODY, 70);
    bodyLines.forEach((l, i) => {
      parts.push(line(l, headingY + 30 + i * 26, { size: 18 }));
    });
  }
  // warning: "none" → leave the bottom space empty on purpose.

  parts.push(`</g></svg>`);
  return parts.join("\n");
}

const LABELS = [
  {
    file: "oldtom-pass.png",
    brand: "OLD TOM DISTILLERY",
    klass: "Kentucky Straight Bourbon Whiskey",
    abv: "45% Alc./Vol. (90 Proof)",
    net: "750 mL",
    bottler: "bottled by Old Tom Distillery, 123 Main St, Louisville, KY",
    warning: "correct",
  },
  {
    // Label says 50%/100 Proof; application (expected-results.json) says 45%/90 → alcohol_content flag.
    file: "blackridge-abv-mismatch.png",
    brand: "BLACK RIDGE",
    klass: "Kentucky Straight Bourbon Whiskey",
    abv: "50% Alc./Vol. (100 Proof)",
    net: "750 mL",
    bottler: "bottled by Black Ridge Distillery, 456 Oak Ave, Bardstown, KY",
    warning: "correct",
  },
  {
    // Brand rendered ALL CAPS on label; app says "Stone's Throw" — casing only → should still pass.
    file: "stonesthrow-style.png",
    brand: "STONE'S THROW",
    klass: "Straight Rye Whisky",
    abv: "40% Alc./Vol. (80 Proof)",
    net: "750 mL",
    bottler: "bottled by Stone's Throw Distilling, 78 Creek Rd, Lawrenceburg, IN",
    warning: "correct",
  },
  {
    // Warning heading 'Government Warning:' title-case, not bold → warning flag.
    file: "aurora-warn-titlecase.png",
    brand: "AURORA RESERVE",
    klass: "American Gin",
    abv: "47% Alc./Vol.",
    net: "750 mL",
    bottler: "bottled by Aurora Reserve Spirits, 9 Harbor Way, Portland, OR",
    warning: "titlecase",
  },
  {
    // No government warning block at all → warning missing flag.
    file: "harbor-warn-missing.png",
    brand: "HARBOR LIGHT",
    klass: "Pale Ale",
    abv: "5.2% Alc./Vol.",
    net: "355 mL",
    bottler: "brewed by Harbor Light Brewing, 21 Pier Ln, Portsmouth, NH",
    warning: "none",
  },
];

mkdirSync(OUT_DIR, { recursive: true });

for (const spec of LABELS) {
  const svg = labelSvg(spec);
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  const out = join(OUT_DIR, spec.file);
  writeFileSync(out, png);
  console.log(`${spec.file}: ${png.length} bytes -> ${out}`);
}

console.log(`done: ${LABELS.length} labels in ${OUT_DIR}`);
