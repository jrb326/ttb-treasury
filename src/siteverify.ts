/**
 * Server-side Turnstile Siteverify (canonical form).
 *
 * Bot protection for the AI endpoints: an invalid/missing token means no call
 * ever reaches Workers AI, so scripted abuse cannot burn the free tier.
 * Fail-closed: any network error, non-2xx, or malformed body rejects.
 */

import { asRecord } from "./codec";

export interface SiteverifyDeps {
  secret: string;
  /** Deployment-specific frontend hostnames, comma-separated env. */
  hostnamesCsv: string;
}

export interface SiteverifyOk {
  ok: boolean;
  reason?: string;
}

const EXPECTED_ACTION = "verify";

export async function verifyTurnstileToken(
  token: string,
  remoteIp: string | null,
  deps: SiteverifyDeps,
): Promise<SiteverifyOk> {
  const expectedHostnames = new Set(
    deps.hostnamesCsv.split(",").map((h) => h.trim()).filter(Boolean),
  );

  if (typeof token !== "string" || token.length === 0 || token.length > 2048) {
    return { ok: false, reason: "missing or malformed token" };
  }
  if (expectedHostnames.size === 0) {
    return { ok: false, reason: "TURNSTILE_HOSTNAMES not configured" };
  }

  let result: Record<string, unknown>;
  try {
    const body = new URLSearchParams({ secret: deps.secret, response: token });
    if (remoteIp) body.set("remoteip", remoteIp);
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return { ok: false, reason: `siteverify HTTP ${r.status}` };
    result = asRecord(await r.json()) ?? {};
  } catch (err) {
    return { ok: false, reason: `siteverify fetch failed: ${String(err)}` };
  }

  if (result.success !== true) return { ok: false, reason: "siteverify success=false" };
  if (result.action !== EXPECTED_ACTION) {
    return { ok: false, reason: `action mismatch: ${String(result.action)}` };
  }
  if (typeof result.hostname !== "string" || !expectedHostnames.has(result.hostname)) {
    return { ok: false, reason: `hostname not allowed: ${String(result.hostname)}` };
  }
  return { ok: true };
}