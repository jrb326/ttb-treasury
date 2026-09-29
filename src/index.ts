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
import {
  DAILY_BUDGET,
  neuronsFor,
  reserve,
  reserveForImage,
  settle,
  type BudgetD1,
} from "./budget";
import type { LabelApplication, VerificationResult } from "./types";

export interface Env {
  /** Account id + Workers-AI-Edit API token (token set via `wrangler secret put AGENT_AI_TOKEN`). */
  CF_ACCOUNT_ID: string;
  AGENT_AI_TOKEN: string;
  ASSETS: { fetch(req: Request): Promise<Response> };
  TURNSTILE_SECRET: string;
  TURNSTILE_HOSTNAMES: string;
  /** D1 binding backing the daily neuron budget (rate limit); absent in unit tests. */
  BUDGET?: BudgetD1;
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

/** Verify a chunk of items sequentially (each item = one model call).
 *  Returns measured neuron cost (0 when the client never reported usage) so
 *  the caller can settle the daily budget — never invented, argmax-sourced. */
async function verifyItems(
  env: Env,
  chat: ChatClient,
  items: VerifyItem[],
): Promise<{ results: VerificationResult[]; actualNeurons: number; succeeded: number }> {
  const results: VerificationResult[] = [];
  let actualNeurons = 0;
  let succeeded = 0;
  let seenPrompt = 0;
  let seenCompletion = 0;
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
      // usageTotal is cumulative across ALL calls (incl. retry-on-garbage):
      // charge exactly the delta this label added — never a single-call read
      // that would silently drop a retry's tokens.
      const u = chat.usageTotal;
      if (u && (u.prompt > seenPrompt || u.completion > seenCompletion)) {
        actualNeurons += neuronsFor(u.prompt - seenPrompt, u.completion - seenCompletion);
        seenPrompt = u.prompt;
        seenCompletion = u.completion;
      }
      succeeded++;
      const verdict = verifyLabel({ file: item.file, app: item.app, extraction, latencyMs: Date.now() - started });
      results.push({ ...verdict, extraction });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ ...errorResult(item.file, `verification failed: ${msg}`, Date.now() - started), extraction: null });
    }
  }
  return { results, actualNeurons, succeeded };
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

      // Daily free-tier rate limit (Workers AI: 10,000 neurons/day free,
      // reset 00:00 UTC). Reserve BEFORE any model call — fails closed, no AI
      // access once today's cap is spent. Per-label reserve scales with image
      // pixel size (phone photo ≠ fixture); settle afterwards charges real
      // usage and may exceed the reservation (ledger never under-reports).
      // No BUDGET binding (unit tests, wrangler without d1) → limit skipped.
      const costs = items.map((it) => reserveForImage(it.image));
      let reservation = costs.reduce((a, b) => a + b, 0);
      if (env.BUDGET) {
        const r = await reserve(env.BUDGET, costs);
        if (!r.ok) {
          return json({
            error: "DAILY_BUDGET_EXHAUSTED",
            reason:
              `Today's AI budget is spent (${r.used} / ${DAILY_BUDGET} neurons). ` +
              "Resets at 00:00 UTC — come back tomorrow, or ask the operator to raise the cap.",
          }, 429);
        }
        reservation = r.reserved;
      }

      const chat = env.CHAT ?? restChatClient(env);
      const { results, actualNeurons, succeeded } = await verifyItems(env, chat, items);

      if (env.BUDGET) {
        // What the ledger must reflect after the run:
        //  - injected test double → 0 (fake calls) → refund the reservation in full
        //  - measured usage (cumulative deltas, retries included) → charge exactly;
        //    can exceed the reservation when the estimate was low — that's an
        //    intentional ledger adjustment toward CF's real number
        //  - no measurement (calls aborted before usage; or usage-missing HTTP)
        //    → keep the reservation (server-side tokens were spent; never invent lower)
        const charged = env.CHAT ? 0
          : succeeded > 0 && actualNeurons > 0 ? actualNeurons
          : reservation;
        await settle(env.BUDGET, charged, reservation);
      }

      return json({ results });
    }

    return json({ error: "not found" }, 404);
  },
};