/**
 * Runtime shape helpers for unvalidated JSON boundaries
 * (model output, siteverify responses, request bodies).
 */

/** Narrow unknown to an indexable plain object, or null. */
export function asRecord(v: unknown): Record<string, unknown> | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  return v as Record<string, unknown>; // object → indexable is structural no-op
}

/** Trimmed non-empty string, or null. */
export function asNonEmptyString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s.length > 0 ? s : null;
}