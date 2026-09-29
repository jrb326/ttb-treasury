/**
 * Federal regulation checklist over the VLM's label observations.
 *
 * One extraction call supplies both the transcribed fields and the cues
 * (`regulation_cues`) the model reports for these rules, so the checklist adds
 * zero extra model latency. Citations verified against 27 CFR via the eCFR API
 * on 2026-09-25 (part 5 = distilled spirits, part 16 = health warning).
 *
 * Status honesty per rule:
 *   pass         — requirement observed satisfied
 *   flag         — VLM observed a violation (prompt asks for clear ones only)
 *   missing      — required marker absent from the extraction (e.g. no warning)
 *   not_checked  — the photo can't answer ("unknown" cue); no claim made
 *
 * Only flag/missing statuses roll up into the overall verdict.
 */

import type { Extraction, FieldStatus, RuleCheck } from "./types";

/** Map a VLM issue cue ("none" / "unknown" / description) onto a verdict status. */
function cueStatus(issue: string, absentClean = false): FieldStatus {
  if (issue === "none") return "pass";
  if (issue === "unknown") return "not_checked";
  return absentClean ? "missing" : "flag";
}

export function buildRegChecks(ext: Extraction): RuleCheck[] {
  const cues = ext.regulation_cues;
  const g = ext.government_warning;
  /** Evidence text for a cue-based row. */
  const evidence = (clean: string, issue: string): string =>
    issue === "none" ? clean : issue === "unknown" ? "Photo insufficient to confirm" : issue;

  const headingOk =
    g.heading_as_printed.trim().toUpperCase().replace(/\s+/g, " ") === "GOVERNMENT WARNING:";

  return [
    {
      id: "brand_present",
      requirement: "Brand name printed on the label",
      citation: "27 CFR 5.64(a)",
      status: ext.brand_name ? "pass" : "missing",
      detail: ext.brand_name
        ? `Extracted brand: "${ext.brand_name}"`
        : "Model found no brand name on the label",
    },
    {
      id: "brand_format",
      requirement: "Brand name free of embedded quality/age claims",
      citation: "27 CFR 5.64(b)–(d)",
      status: cueStatus(cues.brand_format_issue),
      detail: evidence("No claims embedded in the brand name", cues.brand_format_issue),
    },
    {
      id: "type_designation",
      requirement: "Class/type designation is a correct standard identity",
      citation: "27 CFR 5.63(a)(2) · subpart I",
      status: cueStatus(cues.type_designation_issue),
      detail: evidence("Model found an appropriate standard designation", cues.type_designation_issue),
    },
    {
      id: "alcohol_present",
      requirement: "Alcohol content stated as % ABV",
      citation: "27 CFR 5.65(a)",
      status: ext.alcohol_content ? "pass" : "missing",
      detail: ext.alcohol_content
        ? `Extracted: ${ext.alcohol_content}`
        : "No alcohol content found on the label",
    },
    {
      id: "alcohol_conflict",
      requirement: "No geographic contradiction between type and origin",
      citation: "27 CFR 5.65 · 5.143",
      status: cueStatus(cues.alcohol_type_mismatch),
      detail: evidence(
        "No conflicting geographic claims detected (e.g. Kentucky Straight sourced from California)",
        cues.alcohol_type_mismatch,
      ),
    },
    {
      id: "warning_present",
      requirement: "Government health warning present, verbatim from 27 CFR 16.21",
      citation: "27 CFR 16.21",
      status: g.present ? "pass" : "missing",
      detail: g.present
        ? "Warning block found; body compared verbatim in the fields table"
        : "Warning block not found — mandatory on all alcohol beverages",
    },
    {
      id: "warning_format",
      requirement: "Heading ALL CAPS and bold; body not bold; contrasting background",
      citation: "27 CFR 16.22(a)",
      status: !g.present
        ? "missing"
        : g.heading_as_printed
          ? headingOk && g.heading_bold && !g.body_bold && g.contrast_ok
            ? "pass"
            : "flag"
          : "not_checked",
      detail: `heading="${g.heading_as_printed}" heading_bold=${g.heading_bold} body_bold=${g.body_bold} contrast_ok=${g.contrast_ok}`,
    },
    {
      id: "no_health_claim",
      requirement: "No curative/therapeutic health claim on the label",
      citation: "27 CFR 5.62(f)",
      status: cueStatus(cues.health_claim),
      detail: evidence("No health claims detected", cues.health_claim),
    },
    {
      id: "disclosures",
      requirement: "Neutral-spirit %, colour/additive and age disclosures present when used",
      citation: "27 CFR 5.63(c)",
      status: cueStatus(cues.disclosure_unverifiable),
      detail: evidence(
        "No disclosures triggered by what is printed",
        cues.disclosure_unverifiable,
      ),
    },
    {
      id: "import_contract",
      requirement: "Imports state country of origin and importer/consignee address",
      citation: "27 CFR 5.67 · 5.68 · 19 CFR 134",
      status:
        cues.import_status === "unknown"
          ? "not_checked"
          : cues.import_status === "domestic"
            ? "pass"
            : ext.country_of_origin && ext.bottler
              ? "pass"
              : "missing",
      detail:
        cues.import_status === "unknown"
          ? "Import status unclear from the photo"
          : cues.import_status === "domestic"
            ? "Domestic label — no import statement required"
            : `Import flagged; origin=${ext.country_of_origin || "MISSING"} importer=${ext.bottler || "MISSING"}`,
    },
  ];
}

/** Roll check statuses into the overall verdict contribution. */
export function regulationStatuses(checks: RuleCheck[]): FieldStatus[] {
  return checks.map((c) => c.status);
}