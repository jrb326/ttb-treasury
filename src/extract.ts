/**
 * Vision-model extraction: label image → structured JSON.
 *
 * One model call returns every field plus readability + warning-format cues.
 * Output is coerced with permissive runtime validation; parse failure retries
 * once with a stricter prompt, then surfaces as a verification error (never
 * silently passes). Latency budget: hard-abort at HARD_TIMEOUT_MS (Sarah's
 * 5-second rule — prototype probes stay well under it).
 */

import { asNonEmptyString, asRecord } from "./codec";
import type { Extraction } from "./types";

export const HARD_TIMEOUT_MS = 8000;

export const EXTRACTION_PROMPT = `You are reading an alcohol beverage label for a TTB compliance reviewer. Extract exactly what is PRINTED. Never guess or invent. Use "" when a field is absent.

JSON object keys:
readable: boolean (false if glare/blur/crop/skew makes text unreliable); issues: string[] (image problems, [] if none)
brand_name: string (brand name as printed)
class_type: string (class/type designation, e.g. "Kentucky Straight Bourbon Whiskey")
alcohol_content: string (exact ABV/proof text, e.g. "45% Alc./Vol. (90 Proof)")
net_contents: string (e.g. "750 mL")
bottler: string (bottler/producer/distillery name and address line)
country_of_origin: string (country if shown, esp. imports)
government_warning: object {present: boolean, text: string (body text verbatim), heading_as_printed: string (e.g. "GOVERNMENT WARNING:" exactly as rendered), heading_bold: boolean}

Respond with ONLY the JSON object.`;

/** Coerce whatever the model returned into a well-typed Extraction with sane defaults. */
export function coerceExtraction(raw: unknown): Extraction {
  const o = asRecord(raw) ?? {};
  const warning = asRecord(o.government_warning) ?? {};
  const readability = asRecord(o.readability);
  const issues = Array.isArray(readability?.issues)
    ? readability.issues.filter((i): i is string => typeof i === "string")
    : [];

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
    },
  };
}

/** Parse first {...} block from model output; tolerate ```json fences. */
export function parseModelJson(text: string): unknown {
  const unfenced = text.replace(/```(?:json)?/gi, "").trim();
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("no JSON object in model output");
  return JSON.parse(unfenced.slice(start, end + 1));
}

export interface AiLike {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

/**
 * Run extraction with one retry on unparseable output.
 * Throws (caller turns into per-image error verdict) on double-failure.
 */
export async function extractLabelFields(ai: AiLike, imageUrl: string): Promise<Extraction> {
  const runOnce = async (question: string): Promise<unknown> => {
    const raw = await ai.run("cf/moondream/moondream3.1-9B-A2B", {
      task: "query",
      image: imageUrl,
      question,
      max_tokens: 1200,
      temperature: 0,
      reasoning: false,
    });
    const result = asRecord(raw);
    if (!result) throw new Error("empty model response");
    if (typeof result.answer === "string") return parseModelJson(result.answer);
    return raw; // some runtimes return parsed JSON directly
  };

  const attempt1 = await runOnce(EXTRACTION_PROMPT);
  const first = coerceExtraction(attempt1);

  // Empty extraction → likely prose/garbage output; retry once, stricter.
  const empty = !first.brand_name && !first.class_type && !first.alcohol_content && !first.net_contents
    && !first.government_warning.present;
  if (!empty) return first;

  const attempt2 = await runOnce(
    EXTRACTION_PROMPT + "\nCRITICAL: respond with ONLY a JSON object, no prose, no explanation.",
  );
  return coerceExtraction(attempt2);
}

/**
 * Extract with a hard wall-clock budget. The AI binding cannot be aborted, so
 * the race only bounds the caller: the model call may finish into the void,
 * never blocks the response past HARD_TIMEOUT_MS.
 */
export async function extractWithBudget(ai: AiLike, imageUrl: string): Promise<Extraction> {
  let cancelBudget: () => void = () => {};
  const budget = new Promise<never>((_, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`extraction exceeded ${HARD_TIMEOUT_MS}ms budget`)),
      HARD_TIMEOUT_MS,
    );
    cancelBudget = () => clearTimeout(timer);
  });
  try {
    return await Promise.race([extractLabelFields(ai, imageUrl), budget]);
  } finally {
    cancelBudget();
  }
}