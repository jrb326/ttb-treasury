/** Shared domain types for label verification. */

/** A single field's verification outcome. */
export type FieldStatus = "pass" | "flag" | "missing" | "error" | "not_checked";

export interface FieldVerdict {
  /** Value from the application/COLA record. */
  expected: string | null;
  /** Value read from the label image. */
  onLabel: string | null;
  status: FieldStatus;
  note?: string;
}

/** Overall verdict for an image. Tool flags; the agent decides. */
export type Verdict = "pass" | "flag" | "error";

/** A label application as submitted (COLA record side). */
export interface LabelApplication {
  brandName: string;
  classType: string;
  alcoholContent: string;
  netContents: string;
  countryOfOrigin?: string;
  /** Name/address of bottler or producer printed on the label (27 CFR 5.63(b)). */
  bottler?: string;
}

/** What the vision model read off the image. */
export interface Extraction {
  readability: { readable: boolean; issues: string[] };
  brand_name: string;
  class_type: string;
  alcohol_content: string;
  net_contents: string;
  bottler: string;
  country_of_origin: string;
  government_warning: {
    present: boolean;
    text: string;
    heading_as_printed: string;
    heading_bold: boolean;
    /** Body text (beyond "GOVERNMENT WARNING") printed bold — forbidden by 27 CFR 16.22(a)(2). */
    body_bold: boolean;
    /** Warning sits on a contrasting background — 27 CFR 16.22(a)(1). */
    contrast_ok: boolean;
    /** Warning body readable at normal size, or a visual smallness complaint (27 CFR 16.22(b)). */
    size_issue: string;
  };
  /** Model-side cues for the federal-regulation checklist. "" or "none" = no issue seen; "unknown" = photo can't answer. */
  regulation_cues: {
    brand_format_issue: string;
    type_designation_issue: string;
    alcohol_type_mismatch: string;
    health_claim: string;
    disclosure_unverifiable: string;
    import_status: "imported" | "domestic" | "unknown";
  };
}

export interface VerificationResult {
  /** Image identifier (file name / submission key). */
  file: string;
  status: Verdict;
  latencyMs: number;
  /** Image problems (glare, skew, blur) reported by extraction. */
  imageIssues: string[];
  fields: {
    brandName: FieldVerdict;
    classType: FieldVerdict;
    alcoholContent: FieldVerdict;
    netContents: FieldVerdict;
    bottler?: FieldVerdict;
    countryOfOrigin?: FieldVerdict;
    warning: FieldVerdict;
  };
  /** Human-readable summary lines for the UI. */
  summary: string[];
  /** Raw model extraction (label → form prefill). null when extraction failed. */
  extraction?: Extraction | null;
  /** Federal regulation checklist (deterministic rules over VLM observations). */
  regulations?: RuleCheck[];
}

/** One row of the federal-regulation checklist. */
export interface RuleCheck {
  id: string;
  /** Checklist line. */
  requirement: string;
  /** Citation appended after an em dash. */
  citation: string;
  status: FieldStatus;
  /** Evidence: what the model saw, or the extracted value. */
  detail: string;
}