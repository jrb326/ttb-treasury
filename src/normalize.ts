/**
 * Deterministic text normalization + comparison rules.
 *
 * Everything the AI cannot be trusted with (does text A equal text B?) lives
 * here instead — plain functions, no model calls, unit-testable.
 */

import { WARNING_BODY } from "./warning";

/** Canonical form for equality checks: lowercase, strip punctuation/diacritics, collapse whitespace. */
export function normalize(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // diacritics
    .toLowerCase()
    .replace(/[’‘`']/g, "") // apostrophes removed so "STONE'S" == "STONES"
    .replace(/æ/g, "ae")
    .replace(/[^a-z0-9%./\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Words only (punctuation/hyphen folded away) — for weird phrasing differences. */
function words(s: string): string[] {
  return normalize(s)
    .split(/[\s-]+/)
    .filter(Boolean);
}

/** Bag-of-words similarity in [0,1]: 2·|∩| / |A|+|B|, position-independent. */
export function wordSetSimilarity(a: string, b: string): number {
  const wa = words(a);
  const wb = words(b);
  if (wa.length === 0 && wb.length === 0) return 1;
  const counts = new Map<string, number>();
  for (const w of wa) counts.set(w, (counts.get(w) ?? 0) + 1);
  let shared = 0;
  for (const w of wb) {
    const c = counts.get(w) ?? 0;
    if (c > 0) {
      shared++;
      counts.set(w, c - 1);
    }
  }
  return (2 * shared) / (wa.length + wb.length);
}

/** Bounded Levenshtein over word lists; returns -1 if provably > max. */
function wordEditDistance(a: string[], b: string[], max: number): number {
  if (Math.abs(a.length - b.length) > max) return -1;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let cur = new Array<number>(n + 1);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return -1;
    [prev, cur] = [cur, prev];
  }
  return prev[n] <= max ? prev[n] : -1;
}

export type TextMatch = "exact" | "style_only" | "similar" | "mismatch";

/** Classify label-vs-application text. Style-only = same words, different casing/punctuation. */
export function matchText(expected: string, actual: string): TextMatch {
  const e = expected.trim();
  const a = actual.trim();
  if (!e || !a) return "mismatch";
  if (e === a) return "exact";
  if (normalize(e) === normalize(a)) return "style_only";

  const we = words(e);
  const wa = words(a);

  // Controlled typo tolerance: ≥6 words, ≤1 edit per 8 words (OCR garbles).
  if (we.length >= 6 && wa.length >= 6 && Math.abs(we.length - wa.length) <= 1) {
    const maxEdits = Math.floor(we.length / 8);
    if (wordEditDistance(we, wa, maxEdits) >= 0) return "similar";
    if (maxEdits === 0 && wordSetSimilarity(e, a) >= 0.8) return "similar";
    return wordSetSimilarity(e, a) >= 0.9 ? "similar" : "mismatch";
  }

  return wordSetSimilarity(e, a) >= 0.8 ? "similar" : "mismatch";
}

export function parseAbv(s: string): { pct: number | null; proof: number | null } {
  const norm = normalize(s);
  const pctMatch = norm.match(/(\d{1,3}(?:\.\d+)?)\s*%/);
  const proofMatch = norm.match(/(\d{1,3}(?:\.\d+)?)\s*proof/);
  return {
    pct: pctMatch ? Number(pctMatch[1]) : null,
    proof: proofMatch ? Number(proofMatch[1]) : null,
  };
}

/**
 * ABV match. Both sides reduced to a common scale: ABV% = pct, or proof/2.
 * Tolerance ±0.5% ABV (= ±1 proof). Covers "45% Alc./Vol." vs "90 Proof".
 * Neither side parseable → falls back to string comparison.
 */
export function matchAbv(expected: string, actual: string): TextMatch {
  const e = parseAbv(expected);
  const a = parseAbv(actual);
  const asAbv = (v: { pct: number | null; proof: number | null }) =>
    v.pct !== null ? v.pct : v.proof !== null ? v.proof / 2 : null;
  const eAbv = asAbv(e);
  const aAbv = asAbv(a);
  if (eAbv === null || aAbv === null) return matchText(expected, actual);
  return Math.abs(eAbv - aAbv) <= 0.5 ? "exact" : "mismatch";
}

const ML_PER_UNIT: Record<string, number> = {
  ml: 1, milliliter: 1, milliliters: 1, millilitre: 1, millilitres: 1,
  l: 1000, liter: 1000, liters: 1000, litre: 1000, litres: 1000,
  gal: 3785.41, gallon: 3785.41, gallons: 3785.41,
  floz: 29.5735, fluidounces: 29.5735, oz: 29.5735,
};

/** Parse "750 mL", "1 L", "1.5 L", "200 mL" → milliliters when interpretable. */
export function parseVolume(s: string): { ml: number } | null {
  const m = normalize(s).match(
    /(\d+(?:\.\d+)?)\s*(ml|l|liter|liters|litre|litres|milliliter(?:s)?|millilitre(?:s)?|gal(?:lon)?s?|fl\s?oz|fluid\s?ounces?|oz)/,
  );
  if (!m) return null;
  const factor = ML_PER_UNIT[m[2].replace(/\s+/g, "")];
  if (factor === undefined) return null;
  return { ml: Number(m[1]) * factor };
}

/** Net contents match: same volume after unit conversion (L vs mL acceptable). */
export function matchNetContents(expected: string, actual: string): TextMatch {
  const ev = parseVolume(expected);
  const av = parseVolume(actual);
  if (ev && av) return Math.abs(ev.ml - av.ml) / Math.max(ev.ml, av.ml) < 0.001 ? "exact" : "mismatch";
  return matchText(expected, actual);
}

/**
 * Warning checks against 27 CFR 16.22: (1) body text vs canonical statement
 * (16.21/16.23), (2) heading rendered ALL CAPS **and** bold, (3) the remainder
 * of the statement must NOT be bold — 16.22(a)(2).
 */
export function compareWarning(
  labelText: string,
  headingAsPrinted: string,
  headingBold: boolean,
  bodyBold = false,
): { textMatch: TextMatch; headingPass: boolean; headingNotice: string | null } {
  // Extractors return the stamp together with the body ("GOVERNMENT WARNING: (1)…").
  // The heading is judged separately below — drop any leading heading before
  // comparing the body, so an honest label isn't flagged as "similar".
  const body = labelText.replace(/^\s*GOVERNMENT\s+WARNING\s*:?\s+/i, "");
  const textMatch = matchText(WARNING_BODY, body);
  const headingOk =
    headingAsPrinted.trim().toUpperCase().replace(/\s+/g, " ") === "GOVERNMENT WARNING:";
  const headingPass = headingOk && headingBold && !bodyBold;
  const headingNotice = !headingOk
    ? `Heading printed as “${headingAsPrinted}” — must be ALL CAPS “GOVERNMENT WARNING:”.`
    : !headingBold
      ? "“GOVERNMENT WARNING” must be in bold type (TTB formatting rule)."
      : bodyBold
        ? "Text after the heading must NOT be bold — only “GOVERNMENT WARNING” may be bold (27 CFR 16.22(a)(2))."
        : null;
  return { textMatch, headingPass, headingNotice };
}