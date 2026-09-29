/**
 * Daily AI-neuron budget — Workers AI free tier rate limit.
 *
 * Cloudflare free allocation: 10,000 neurons/day for the account (resets
 * 00:00 UTC). Two facts keep this honest:
 *   - Exceeding the free allocation means Cloudflare QUOTA KILLS THE SWITCH:
 *     past 10k, further Workers AI operations simply fail. Our budget's job
 *     is preventing those mid-day 429s with readable errors — and keeping the
 *     Worker a good citizen instead of grinding against the hard stop.
 *   - Scout (llama-4-scout-17b-16e-instruct): 24,545 neurons/M in, 77,273/M out.
 *
 * Two-phase ledger in D1 (stateless Worker, D1 = only durable state):
 *   reserve(costs[]) BEFORE any model call — atomic guarded UPDATE, fail-closed
 *   settle(charged, reservation) after    — refund shortfall, CHARGE overshoot
 *     (settle may exceed the reservation: the ledger must never under-report
 *     what Cloudflare actually billed — that's the silent-overage bug).
 *
 * Cost model per label is size-aware: parse the image header (src/imageSize.ts)
 * and convert dimensions → conservative input-token estimate at scout rates.
 * Phoned-in 12MP photos then book ~760 neurons instead of a flat 120 that
 * would under-reserve 6×.
 */

import { parseImageDimensions } from "./imageSize";

/** Flat reserve when dimensions are unparseable (unknown format — never guess big). */
export const RESERVE_PER_LABEL = 120;

/**
 * Daily cap (neurons). 8,000 = 20% headroom under CF's 10,000/day hard stop,
 * so estimator error and aborted-but-billed calls land here instead of
 * hitting the account ceiling (which fails all further AI operations).
 */
export const DAILY_BUDGET = 8000;

export const SCOUT_INPUT_PER_M = 24545;
export const SCOUT_OUTPUT_PER_M = 77273;

/** Measured: ~2.1-2.3k prompt tokens for an 800x1100 fixture (≈2k image+text).
 *  Estimate = image-token proxy (w*h/400) + text headroom, floored at 1,600,
 *  plus 80 completion tokens. 800x1100 → 2,500 in (9% above measured); a
 *  4032x3024 phone photo → ~30.8k in ≈ 762 neurons/label (10/batch fits the
 *  cap; next one 429s — correct behavior). */
const INPUT_FLOOR_TOKENS = 1600;
const IMG_TOKENS_PER_PIXEL = 400;
const TEXT_HEADROOM_TOKENS = 300;
const OUT_MARGIN_TOKENS = 80;

/** Conservative neuron reservation for one label of the given pixel size. */
export function estimateLabelReserve(width?: number | null, height?: number | null): number {
  if (!width || !height) return RESERVE_PER_LABEL;
  const imgTokens = Math.ceil((width * height) / IMG_TOKENS_PER_PIXEL);
  const inTokens = Math.max(INPUT_FLOOR_TOKENS, imgTokens + TEXT_HEADROOM_TOKENS);
  const inNeurons = Math.ceil((inTokens * SCOUT_INPUT_PER_M) / 1_000_000);
  const outNeurons = Math.ceil((OUT_MARGIN_TOKENS * SCOUT_OUTPUT_PER_M) / 1_000_000);
  return Math.max(RESERVE_PER_LABEL, inNeurons + outNeurons);
}

/** Per-item reserve from a data-URI / raw base64 image. */
export function reserveForImage(imageDataUri: string): number {
  return estimateLabelReserve(...(() => {
    const d = parseImageDimensions(imageDataUri);
    return d ? [d.width, d.height] as const : [null, null] as const;
  })());
}

export interface BudgetD1 {
  prepare(sql: string): {
    bind(...args: unknown[]): { first<T>(): Promise<T | null>; run(): Promise<unknown> };
    first<T>(): Promise<T | null>;
    run(): Promise<unknown>;
  };
}

/** The UTC day-key CF uses (00:00 UTC reset). */
export function utcDay(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export interface ReserveResult {
  ok: boolean;
  reserved: number; // 0 when rejected
  used: number;     // today's total after reservation (or pre-state on reject)
  left: number;
}

/**
 * Book sum(costs) against today in ONE guarded statement (after an
 * INSERT-if-absent). Over-cap → ok:false, nothing booked, no model call runs.
 */
export async function reserve(db: BudgetD1, costs: number[]): Promise<ReserveResult> {
  const cost = costs.reduce((a, b) => a + b, 0);
  const day = utcDay();
  await db
    .prepare("INSERT INTO ai_budget(day, neurons) VALUES(?, 0) ON CONFLICT(day) DO NOTHING")
    .bind(day)
    .run();
  const row = await db
    .prepare(
      "UPDATE ai_budget SET neurons = neurons + ? WHERE day = ? AND neurons + ? <= ? RETURNING neurons",
    )
    .bind(cost, day, cost, DAILY_BUDGET)
    .first<{ neurons: number }>();
  if (!row) {
    const cur = await db
      .prepare("SELECT neurons FROM ai_budget WHERE day = ?")
      .bind(day)
      .first<{ neurons: number }>();
    const used = cur?.neurons ?? DAILY_BUDGET;
    return { ok: false, reserved: 0, used, left: Math.max(0, DAILY_BUDGET - used) };
  }
  return { ok: true, reserved: cost, used: row.neurons, left: DAILY_BUDGET - row.neurons };
}

/**
 * Move the ledger from `reserved` to `charged`:
 *   charged < reserved → refund the shortfall
 *   charged > reserved → CHARGE the overshoot (real spend exceeded estimate —
 *     ledger must reflect what CF billed; the next reserve's guard then 429s)
 */
export async function settle(db: BudgetD1, charged: number, reserved: number): Promise<void> {
  const delta = charged - reserved;
  if (delta === 0) return;
  const day = utcDay();
  if (delta > 0) {
    await db
      .prepare("UPDATE ai_budget SET neurons = neurons + ? WHERE day = ?")
      .bind(delta, day)
      .run();
  } else {
    await db
      .prepare("UPDATE ai_budget SET neurons = MAX(0, neurons - ?) WHERE day = ?")
      .bind(-delta, day)
      .run();
  }
}

/** Neurons at scout rates for given token counts (already-used paths). */
export function neuronsFor(promptTokens: number, completionTokens: number): number {
  return Math.ceil(
    (promptTokens * SCOUT_INPUT_PER_M + completionTokens * SCOUT_OUTPUT_PER_M) / 1_000_000,
  );
}