/**
 * Vision-model extraction: label image → typed Extraction JSON.
 *
 * One chat turn with the image inline; strict JSON prompt; parse coercion with
 * one retry on garbage output. Prompt kept SHORT deliberately: 5.5–7.6 s with
 * the long form, down to 3.9–6.1 s (median 5.2 s) trimmed — Sarah's 5 s rule
 * wins over prompt bluntness; the badge reports whatever actually happens.
 */

import type { ChatClient, TextPart, ImagePart } from "./completions";
import { asNonEmptyString, asRecord } from "./codec";
import type { Extraction } from "./types";

export const HARD_TIMEOUT_MS = 9000;

/**
 * The app's primary job: photo → structured label data (form prefill).
 * Comparison against a filed application only runs when the form carries values.
 */
export const EXTRACTION_PROMPT = `You are reading an alcohol beverage label for a TTB compliance reviewer. Extract exactly what is PRINTED. Never guess or invent. Use "" when absent.
JSON keys: readable (boolean), issues (string[]), brand_name, class_type, alcohol_content, net_contents, bottler, country_of_origin (strings), government_warning {present, text (body verbatim), heading_as_printed, heading_bold, body_bold, contrast_ok, size_issue}, regulation_cues {brand_format_issue, type_designation_issue, alcohol_type_mismatch, health_claim, disclosure_unverifiable, import_status}.
For each cue string reply ONE of: "none", "unknown", or a very short quote (max 8 words). issue strings likewise max 8 words. import_status: imported|domestic|unknown. size_issue: "none" unless the warning text is visibly tiny or unreadably small, then a short phrase.
Reply with ONLY the JSON object.`;

/** Coerce whatever the model returned into a well-typed Extraction with sane defaults. */
export function coerceExtraction(raw: unknown): Extraction {
  const o = asRecord(raw) ?? {};
  const warning = asRecord(o.government_warning) ?? {};
  const cues = asRecord(o.regulation_cues) ?? {};
  const readability = asRecord(o.readability);
  const issues = Array.isArray(readability?.issues)
    ? readability.issues.filter((i): i is string => typeof i === "string")
    : [];
  // Cue tri-state: reported issue / "none" / "unknown". Absent key = assume clean ("none").
  const cue = (v: unknown): string => {
    const s = asNonEmptyString(v);
    if (!s) return "none";
    const lc = s.trim().toLowerCase();
    return lc === "unknown" ? "unknown" : s.trim();
  };
  const imp = asNonEmptyString(cues.import_status)?.toLowerCase();

  return {
    // Absent readability info → assume readable; explicit false only from the model.
    readability: { readable: readability?.readable !== false, issues },
    brand_name: asNonEmptyString(o.brand_name) ?? "",
    class_type: asNonEmptyString(o.class_type) ?? "",
    alcohol_content: asNonEmptyString(o.alcohol_content) ?? "",
    net_contents: asNonEmptyString(o.net_contents) ?? "",
    bottler: asNonEmptyString(o.bottler) ?? "",
    country_of_origin: asNonEmptyString(o.country_of_origin) ?? "",
    government_warning: {
      present: warning.present === true,
      text: asNonEmptyString(warning.text) ?? "",
      heading_as_printed: asNonEmptyString(warning.heading_as_printed) ?? "",
      heading_bold: warning.heading_bold === true,
      body_bold: warning.body_bold === true,
      /** Contrasting background (27 CFR 16.22(a)(1)); absent signal → assume compliant. */
      contrast_ok: warning.contrast_ok !== false,
      /** Visual smallness complaint (27 CFR 16.22(b)); absent signal → assume readable. */
      size_issue: asNonEmptyString(warning.size_issue) || "none",
    },
    regulation_cues: {
      brand_format_issue: cue(cues.brand_format_issue),
      type_designation_issue: cue(cues.type_designation_issue),
      alcohol_type_mismatch: cue(cues.alcohol_type_mismatch),
      health_claim: cue(cues.health_claim),
      disclosure_unverifiable: cue(cues.disclosure_unverifiable),
      import_status: imp === "imported" || imp === "domestic" ? imp : "unknown",
    },
  };
}

/** Parse first {...} block from model output; tolerate ``` fences and prose around it. */
export function parseModelJson(text: string): unknown {
  const unfenced = text.replace(/```(?:json)?/gi, "").trim();
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("no JSON object in model output");
  return JSON.parse(unfenced.slice(start, end + 1));
}

/**
 * Run extraction with one retry on unparseable/empty output.
 * Throws (caller turns into per-image error verdict) on double-failure.
 */
export async function extractLabelFields(chat: ChatClient, imageUrl: string): Promise<Extraction> {
  const content: Array<TextPart | ImagePart> = [
    { type: "text", text: EXTRACTION_PROMPT },
    { type: "image_url", image_url: { url: imageUrl } },
  ];
  const first = coerceExtraction(parseModelJson(await chat.complete(content, { maxTokens: 600 })));

  const empty = !first.brand_name && !first.class_type && !first.alcohol_content && !first.net_contents
    && !first.government_warning.present;
  if (!empty) return first;

  const retryContent: Array<TextPart | ImagePart> = [
    { type: "text", text: EXTRACTION_PROMPT + "\nCRITICAL: respond with ONLY a JSON object, no prose, no markdown fences." },
    { type: "image_url", image_url: { url: imageUrl } },
  ];
  return coerceExtraction(parseModelJson(await chat.complete(retryContent, { maxTokens: 600 })));
}

/**
 * Extract with a hard wall-clock budget. fetch aborts inside the client; the
 * extra race guards over-abstractioned clients (fakes) from hanging callers.
 */
export async function extractWithBudget(chat: ChatClient, imageUrl: string): Promise<Extraction> {
  let cancelBudget: () => void = () => {};
  const budget = new Promise<never>((_, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`extraction exceeded ${HARD_TIMEOUT_MS}ms budget`)),
      HARD_TIMEOUT_MS,
    );
    cancelBudget = () => clearTimeout(timer);
  });
  try {
    return await Promise.race([extractLabelFields(chat, imageUrl), budget]);
  } finally {
    cancelBudget();
  }
}