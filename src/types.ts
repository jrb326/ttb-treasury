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
    countryOfOrigin?: FieldVerdict;
    warning: FieldVerdict;
  };
  /** Human-readable summary lines for the UI. */
  summary: string[];
}