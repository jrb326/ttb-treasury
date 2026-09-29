/**
 * Worker entry: static assets + /api/* with Turnstile-gated AI verification.
 *
 * Every POST /api/* passes server-side Siteverify BEFORE anything touches
 * Workers AI — bots without a valid token can never consume free-tier AI quota.
 */

import { restChatClient, type ChatClient } from "./completions";
import { extractWithBudget } from "./extract";
import { asNonEmptyString, asRecord } from "./codec";
import { verifyTurnstileToken } from "./siteverify";
import { errorResult, verifyLabel } from "./verify";
import type { LabelApplication, VerificationResult } from "./types";

export interface Env {
  /** Account id + Workers-AI-Edit API token (token set via `wrangler secret put AGENT_AI_TOKEN`). */
  CF_ACCOUNT_ID: string;
  AGENT_AI_TOKEN: string;
  ASSETS: { fetch(req: Request): Promise<Response> };
  TURNSTILE_SECRET: string;
  TURNSTILE_HOSTNAMES: string;
  /** Tests inject a fake; production falls back to the REST chat client. */
  CHAT?: ChatClient;
}

/** Chunk size the UI sends; also the server's hard cap per request.
 *  Deliberately not exported: Workers service entrypoints may only export handlers. */
const MAX_ITEMS_PER_REQUEST = 10;
/** Per-image decode cap: labels are photos, not raw scans. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** Pull the Turnstile token from a JSON / multipart / urlencoded body. */
export async function readTurnstileToken(contentType: string, body: string): Promise<string | "unsupported"> {
  if (contentType.includes("application/json")) {
    const t = asRecord(asRecord(safeParse(body))?.turnstile);
    return typeof t?.token === "string" ? t.token : "";
  }
  if (contentType.includes("multipart/form-data")) {
    const form = await new Request("https://internal", {
      method: "POST",
      headers: { "Content-Type": contentType },
      body,
    }).formData();
    return form.get("cf-turnstile-response")?.toString() ?? "";
  }
  if (contentType.includes("application/x-www-form-urlencoded")) {
    return new URLSearchParams(body).get("cf-turnstile-response") ?? "";
  }
  return "unsupported";
}

interface VerifyItem {
  file: string;
  /** data URL ("data:image/png;base64,...") or fully-qualified https URL. */
  image: string;
  app: LabelApplication | null;
}

function parseItem(raw: unknown, index: number): VerifyItem | null {
  const o = asRecord(raw);
  if (!o) return null;
  const file = asNonEmptyString(o.file) ?? `item-${index + 1}`;
  const image = asNonEmptyString(o.image);
  if (!image) return null;
  const appRaw = asRecord(o.app);
  // Every check field optional (CSV rows may be partial); brand name anchors the row.
  const app: LabelApplication | null = appRaw
    ? {
        brandName: asNonEmptyString(appRaw.brandName) ?? "",
        classType: asNonEmptyString(appRaw.classType) ?? "",
        alcoholContent: asNonEmptyString(appRaw.alcoholContent) ?? "",
        netContents: asNonEmptyString(appRaw.netContents) ?? "",
        countryOfOrigin: asNonEmptyString(appRaw.countryOfOrigin) ?? undefined,
        bottler: asNonEmptyString(appRaw.bottler) ?? undefined,
      }
    : null;
  return { file, image, app };
}

/** Verify a chunk of items sequentially (each item = one model call). */
async function verifyItems(env: Env, chat: ChatClient, items: VerifyItem[]): Promise<VerificationResult[]> {
  const results: VerificationResult[] = [];
  for (const item of items) {
    const started = Date.now();
    try {
      if (item.image.startsWith("data:")) {
        const approxBytes = Math.floor((item.image.length * 3) / 4);
        if (approxBytes > MAX_IMAGE_BYTES) {
          results.push(errorResult(item.file, `image too large (${approxBytes} bytes > 8 MB cap)`, 0));
          continue;
        }
      }
      const extraction = await extractWithBudget(chat, item.image);
      const verdict = verifyLabel({ file: item.file, app: item.app, extraction, latencyMs: Date.now() - started });
      results.push({ ...verdict, extraction });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ ...errorResult(item.file, `verification failed: ${msg}`, Date.now() - started), extraction: null });
    }
  }
  return results;
}

/**
 * Turnstile gate for /api/*. Reads nothing — the caller passes the raw body it
 * already read. Fail closed: missing/invalid token, bad action, unlisted
 * hostname, or siteverify network failure all → 403.
 */
async function gateTurnstile(req: Request, env: Env, rawBody: string): Promise<Response | null> {
  const contentType = req.headers.get("Content-Type") ?? "";
  const token = await readTurnstileToken(contentType, rawBody);
  if (token === "unsupported") return json({ error: "unsupported content type" }, 400);

  const verdict = await verifyTurnstileToken(token, req.headers.get("CF-Connecting-IP"), {
    secret: env.TURNSTILE_SECRET,
    hostnamesCsv: env.TURNSTILE_HOSTNAMES,
  });
  if (!verdict.ok) return json({ error: "BOT_CHECK_FAILED", reason: verdict.reason }, 403);
  return null;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(req);
    }
    if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

    let rawBody: string;
    try {
      rawBody = await req.text();
    } catch {
      return json({ error: "unreadable request body" }, 400);
    }

    // Every AI-touching route goes through this before parsing application data.
    const denied = await gateTurnstile(req, env, rawBody);
    if (denied) return denied;

    if (url.pathname === "/api/verify") {
      const root = asRecord(safeParse(rawBody));
      const itemsRaw = Array.isArray(root?.items) ? root.items : null;
      if (!itemsRaw || itemsRaw.length === 0) return json({ error: "items[] required" }, 400);
      if (itemsRaw.length > MAX_ITEMS_PER_REQUEST) {
        return json({ error: `too many items: ${itemsRaw.length} > ${MAX_ITEMS_PER_REQUEST} per request` }, 400);
      }
      const items: VerifyItem[] = [];
      for (let i = 0; i < itemsRaw.length; i++) {
        const item = parseItem(itemsRaw[i], i);
        if (!item) return json({ error: `items[${i}] missing file or image` }, 400);
        items.push(item);
      }
      const results = await verifyItems(env, env.CHAT ?? restChatClient(env), items);
      return json({ results });
    }

    return json({ error: "not found" }, 404);
  },
};