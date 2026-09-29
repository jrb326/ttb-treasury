/**
 * Daily AI-neuron budget — Workers AI free tier rate limit.
 *
 * Cloudflare free allocation: 10,000 neurons/day for the account (resets
 * 00:00 UTC, see developers.cloudflare.com/workers-ai/platform/pricing).
 * Scout (llama-4-scout-17b-16e-instruct): 24,545 neurons/M input tokens,
 * 77,273/M output. Measured on the fixtures: ~2.1-2.3k input + ~280 output
 * ≈ 77 neurons/label → reserve worst-case 120 neurons/label.
 *
 * Two-phase ledger in D1 (stateless Worker, D1 is the only durable state):
 *   reserve(items) before any model call  — REJECTS if day's budget exhausted
 *   settle(actual) after the call        — refunds the difference vs reservation
 * Actual consumption = finalize (outputs included, but measured tiny: ~4-10).
 */

/** Neurons charged for one label; worst case across measured runs + margin. */
export const RESERVE_PER_LABEL = 120;
/**
 * Daily cap (neurons). 8,000 keeps 20% headroom under CF's 10,000 free/day
 * even if the worker retires tokens late or a model costs more than pricelist.
 * = 66 labels/day at the reserve rate.
 */
export const DAILY_BUDGET = 8000;

export interface BudgetD1 {
  prepare(sql: string): {
    bind(...args: unknown[]): { first<T>(): Promise<T | null>; run(): Promise<unknown> };
    first<T>(): Promise<T | null>;
    run(): Promise<unknown>;
  };
}

/** The UTC day-key CF uses to reset limits (00:00 UTC). */
export function utcDay(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export interface ReserveResult {
  ok: boolean;
  /** neurons committed (when ok) */
  reserved: number;
  /** today's total after this reservation */
  used: number;
  /** remaining after */
  left: number;
}

/**
 * Atomically book `labels * RESERVE_PER_LABEL` neurons against today.
 * Over-budget → ok:false (fail closed, no model call is made).
 */
export async function reserve(db: BudgetD1, labels: number): Promise<ReserveResult> {
  const cost = labels * RESERVE_PER_LABEL;
  const day = utcDay();
  // Insert-if-absent then conditional update: D1 has no atomic upsert+CAS,
  // but a single UPDATE with WHERE-guard is atomic per-statement.
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
  const used = row.neurons;
  return { ok: true, reserved: cost, used, left: DAILY_BUDGET - used };
}

/** Refund unused reservation: charge only what labels actually consumed. */
export async function settle(db: BudgetD1, actuallyUsed: number, reserved: number): Promise<void> {
  const delta = reserved - actuallyUsed;
  if (delta <= 0) return; // model overran reservation — already charged the max
  await db
    .prepare("UPDATE ai_budget SET neurons = MAX(0, neurons - ?) WHERE day = ?")
    .bind(delta, utcDay())
    .run();
}

/**
 * Neurons the completed call actually consumed: pricelist rates × measured
 * token usage, floored at 0. kept separate from RESERVE so the refund can be
 * computed exactly. Prompt tokens supplied by the chat client, outputs tiny.
 */
export const SCOUT_INPUT_PER_M = 24545;
export const SCOUT_OUTPUT_PER_M = 77273;

export function actualCost(promptTokens: number, completionTokens: number): number {
  return Math.ceil(
    (promptTokens * SCOUT_INPUT_PER_M) / 1_000_000 +
      (completionTokens * SCOUT_OUTPUT_PER_M) / 1_000_000,
  );
}