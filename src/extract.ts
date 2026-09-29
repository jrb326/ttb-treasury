/**
 * Vision-model extraction: label image → typed Extraction JSON.
 *
 * One chat turn with the image inline; strict JSON prompt; parse coercion with
 * one retry on garbage output. Latency: abstractions around fetch carry a 9s
 * hard timeout (the completions client aborts); deterministic checks are
 * milliseconds — total budget clears Sarah's 5-second rule on the measured
 * path (scout median ≈ 3.7 s over the fixture set).
 */

import type { ChatClient, TextPart, ImagePart } from "./completions";
import { asNonEmptyString, asRecord } from "./codec";
import type { Extraction } from "./types";

export const HARD_TIMEOUT_MS = 9000;

/**
 * The app's primary job: photo → structured label data (form prefill).
 * Comparison against a filed application only runs when the form carries values.
 */
export const EXTRACTION_PROMPT = `You are reading an alcohol beverage label for a TTB compliance reviewer. Extract exactly what is PRINTED. Never guess or invent. Use "" when a field is absent.

JSON keys: readable (boolean; false if glare/blur/crop/skew makes text unreliable), issues (string[] of image problems, [] if none), brand_name, class_type, alcohol_content, net_contents, bottler, country_of_origin (strings), government_warning {present (boolean), text (string, body verbatim), heading_as_printed (e.g. "GOVERNMENT WARNING:" exactly as rendered), heading_bold (boolean), body_bold (boolean; true if any text AFTER the "GOVERNMENT WARNING:" heading is bold/eye-catching), contrast_ok (boolean; false if the warning text and its background preclude easy reading), type_size_mm (number or null; approximate x-height in millimetres of the SMALL body text in the warning — estimate from character density and the label's real-world width of ~90 mm; use null if unreadable)}. TTB requires minimum warning type sizes under 27 CFR 16.22(b): 1 mm for containers ≤237 mL, 2 mm for ≤3 L, 3 mm larger, and a clearly contrasting background (16.22(a)(1)).

Also report regulation_cues {brand_format_issue (string: "none" if the brand name is printed plainly with no age/quality/type claim embedded, otherwise a short description of what violates 27 CFR 5.64; "unknown" if you cannot tell), type_designation_issue (string: "none" if class/type looks like a correct standard identity, else short description; "unknown" if unclear), alcohol_type_mismatch (string: "none" if no state/geographic contradiction between the alcohol statement and the product type (e.g. "Kentucky Straight Bourbon" with "California"), else short description; "unknown" if unclear), health_claim (string: "none" if the label makes no curative/therapeutic or implied health-benefit statement, else short quote; "unknown" if unclear), disclosure_unverifiable (string: "none" if you see no age statement/neutral-spirit %/color additive that would trigger 5.63(c) disclosure, else short description; "unknown" if text too small), import_status ("imported" if the label says imported/imported by/product of a foreign country, "domestic" if US bottler/distiller address only, "unknown" otherwise)}.

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
      type_size_mm:
        typeof warning.type_size_mm === "number" &&
        isFinite(warning.type_size_mm) &&
        warning.type_size_mm > 0
          ? warning.type_size_mm
          : null,
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