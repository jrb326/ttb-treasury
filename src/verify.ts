/**
 * Deterministic verification: Extraction (from image) × LabelApplication (from
 * the COLA record) → per-field verdicts + one overall verdict.
 *
 * Verdict semantics — the tool flags, the agent decides:
 *   pass    (green): text matches, or style-only difference (same words, different
 *           casing/punctuation — Dave's "STONE'S THROW" vs "Stone's Throw").
 *   flag    (yellow): mismatch / warning formatting violation / unreadable image — needs human eyes.
 *   error   (red): extraction failed (timeout, model failure) — no claim possible, don't consume the result.
 *
 * Every rule here is plain deterministic code. No AI decides a verdict.
 */

import {
  compareTypeSize,
  compareWarning,
  matchAbv,
  matchNetContents,
  matchText,
  parseVolume,
  requiredTypeSizeMm,
  type TextMatch,
} from "./normalize";
import { buildRegChecks, regulationStatuses } from "./regulations";
import type {
  Extraction,
  RuleCheck,
  FieldStatus,
  FieldVerdict,
  LabelApplication,
  VerificationResult,
  Verdict,
} from "./types";

/** Map a TextMatch onto status+note per field-name context. */
function matchVerdict(
  mismatchNoun: string,
  expected: string,
  onLabel: string,
  match: TextMatch,
  extraNote?: string,
): FieldVerdict {
  const base = { expected, onLabel };
  switch (match) {
    case "exact":
      return { ...base, status: "pass", note: extraNote };
    case "style_only":
      return {
        ...base,
        status: "pass",
        note: extraNote
          ?? `style-only difference (case/punctuation) — ${mismatchNoun} is the same text`,
      };
    case "similar":
      return {
        ...base,
        status: "flag",
        note: extraNote ?? `close but not exact (${mismatchNoun}) — confirm with a careful read`,
      };
    case "mismatch":
      return {
        ...base,
        status: "flag",
        note: extraNote ?? `${mismatchNoun} does not match the application`,
      };
  }
}

/** Generic text field check (brand, class/type, origin). */
function checkTextField(
  label: string,
  expected: string | null | undefined,
  onLabel: string,
): FieldVerdict {
  const exp = expected?.trim() || null;
  if (exp === null) return { expected: null, onLabel, status: "not_checked", note: `${label} not provided in application` };
  const act = onLabel.trim();
  if (act === "") return { expected: exp, onLabel: null, status: "missing", note: `${label} not found on label` };
  return matchVerdict(label.toLowerCase(), exp, act, matchText(exp, act));
}

/** Alcohol content check with proof/ABV unification (±0.5% ABV tolerance). */
function checkAbv(expected: string | null | undefined, onLabel: string): FieldVerdict {
  const exp = expected?.trim() || null;
  if (exp === null) return { expected: null, onLabel, status: "not_checked", note: "alcohol content not provided in application" };
  const act = onLabel.trim();
  if (act === "") return { expected: exp, onLabel: null, status: "missing", note: "alcohol content not found on label" };
  const m = matchAbv(exp, act);
  if (m === "exact") return { expected: exp, onLabel: act, status: "pass" };
  if (m === "style_only" || m === "similar") {
    return { expected: exp, onLabel: act, status: "flag", note: "close but not exact — confirm ABV/proof" };
  }
  return { expected: exp, onLabel: act, status: "flag", note: "alcohol content does not match the application" };
}

/** Net contents check with unit conversion (750 mL vs 0.75 L acceptable). */
function checkNetContents(expected: string | null | undefined, onLabel: string): FieldVerdict {
  const exp = expected?.trim() || null;
  if (exp === null) return { expected: null, onLabel, status: "not_checked", note: "net contents not provided in application" };
  const act = onLabel.trim();
  if (act === "") return { expected: exp, onLabel: null, status: "missing", note: "net contents not found on label" };
  const m = matchNetContents(exp, act);
  if (m === "exact") return { expected: exp, onLabel: act, status: "pass" };
  return { expected: exp, onLabel: act, status: "flag", note: "net contents do not match the application" };
}

/**
 * Government warning: presence (16.21), exact body text, heading ALL-CAPS AND
 * bold (16.22(a)(2)), remainder NOT bold (16.22(a)(2)), minimum type size by
 * container volume (16.22(b)). Violation → flag; absent → missing.
 */
function checkWarning(ext: Extraction): FieldVerdict {
  const w = ext.government_warning;
  const expected = "27 CFR part 16 health warning statement";
  if (!w.present) {
    return {
      expected,
      onLabel: null,
      status: "missing",
      note: "Government warning NOT FOUND on label — mandatory on all alcohol beverages (27 CFR 16.21)",
    };
  }
  const { textMatch, headingPass, headingNotice } = compareWarning(
    w.text,
    w.heading_as_printed,
    w.heading_bold,
    w.body_bold,
  );
  const onLabel = w.text.trim() || null;

  if (!headingPass) {
    return { expected, onLabel, status: "flag", note: headingNotice ?? "warning heading formatting violation" };
  }

  // Contrast — 27 CFR 16.22(a)(1): readily legible, contrasting background.
  if (!w.contrast_ok) {
    return {
      expected,
      onLabel,
      status: "flag",
      note: "warning text does not sit on a clearly contrasting background (27 CFR 16.22(a)(1)) — must be plainly legible",
    };
  }

  // Type size — 27 CFR 16.22(b): 1 mm ≤237 mL, 2 mm ≤3 L, 3 mm above.
  const requiredMm = requiredTypeSizeMm(parseVolume(ext.net_contents)?.ml ?? null);
  const size = compareTypeSize(w.type_size_mm, requiredMm);
  if (size === "fail") {
    return {
      expected,
      onLabel,
      status: "flag",
      note:
        `warning type size ≈ ${w.type_size_mm} mm — below the ${requiredMm} mm minimum ` +
        "required for this container size (27 CFR 16.22(b)); must be plainly legible",
    };
  }

  switch (textMatch) {
    case "exact":
    case "style_only":
      return { expected, onLabel, status: "pass" };
    case "similar":
      return { expected, onLabel, status: "flag", note: "warning text close but not word-for-word — re-read carefully" };
    case "mismatch":
      return { expected, onLabel, status: "flag", note: "warning text differs from the required verbatim statement" };
  }
}

/** Overall verdict from field statuses: any flag/missing/flag → flag, all clear → pass. */
function rollUp(statuses: FieldStatus[]): Verdict {
  if (statuses.some((s) => s === "flag" || s === "missing")) return "flag";
  return "pass";
}

function statusLabel(v: Verdict): string {
  return v === "pass" ? "PASS" : v === "flag" ? "FLAG" : "ERROR";
}

/** Build human-readable summary lines for the UI. */
function buildSummary(
  fields: VerificationResult["fields"],
  readability: { readable: boolean; issues: string[] },
): string[] {
  const lines: string[] = [];
  for (const [name, field] of Object.entries(fields)) {
    if (!field || typeof field !== "object" || !("status" in field)) continue;
    if (field.status === "not_checked") continue;
    const label = name.replace(/([A-Z])/g, " $1").toLowerCase();
    if (field.status === "pass" && !field.note) {
      lines.push(`${label}: match ✓`);
    } else if (field.status === "pass") {
      lines.push(`${label}: acceptable — ${field.note}`);
    } else if (field.status === "missing") {
      lines.push(`${label}: MISSING — ${field.note}`);
    } else {
      lines.push(`${label}: FLAG — ${field.note}`);
    }
  }
  if (!readability.readable) {
    lines.unshift(`Image may be unreadable: ${readability.issues.join("; ") || "reported by extractor"}`);
  }
  return lines;
}

export interface VerifyLabelArgs {
  file: string;
  app: LabelApplication | null;
  extraction: Extraction;
  latencyMs: number;
}

/** Produce the verification result for one image. */
export function verifyLabel(args: VerifyLabelArgs): VerificationResult {
  const { file, app, extraction, latencyMs } = args;
  const fields: VerificationResult["fields"] = {
    brandName: checkTextField("Brand name", app?.brandName, extraction.brand_name),
    classType: checkTextField("Class/type", app?.classType, extraction.class_type),
    alcoholContent: checkAbv(app?.alcoholContent, extraction.alcohol_content),
    netContents: checkNetContents(app?.netContents, extraction.net_contents),
    warning: checkWarning(extraction),
  };
  if (app?.countryOfOrigin?.trim()) {
    fields.countryOfOrigin = checkTextField("Country of origin", app.countryOfOrigin, extraction.country_of_origin);
  }
  if (app?.bottler?.trim()) {
    fields.bottler = checkTextField("Bottler", app.bottler, extraction.bottler);
  }

  const regChecks = buildRegChecks(extraction);
  const statuses = Object.values(fields)
    .filter((f): f is FieldVerdict => f != null && typeof f === "object" && "status" in f)
    .map((f) => f.status)
    .concat(regulationStatuses(regChecks));
  const status = rollUp(statuses);

  const partial = {
    file,
    status,
    latencyMs,
    imageIssues: extraction.readability.issues,
    fields,
    regulations: regChecks,
  } as const;

  return { ...partial, summary: buildSummary(fields, extraction.readability) };
}

/** Verdict for a failed extraction (timeout / model error): never guess, surface as error. */
export function errorResult(file: string, message: string, latencyMs: number): VerificationResult {
  return {
    file,
    status: "error",
    latencyMs,
    imageIssues: [],
    fields: {
      brandName: { expected: null, onLabel: null, status: "error", note: "extraction failed" },
      classType: { expected: null, onLabel: null, status: "error", note: "extraction failed" },
      alcoholContent: { expected: null, onLabel: null, status: "error", note: "extraction failed" },
      netContents: { expected: null, onLabel: null, status: "error", note: "extraction failed" },
      warning: { expected: null, onLabel: null, status: "error", note: "extraction failed" },
    },
    summary: [`${statusLabel("error")}: ${message}`],
  };
}