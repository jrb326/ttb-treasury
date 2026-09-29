import { describe, it, expect } from "vitest";
import {
  DAILY_BUDGET,
  RESERVE_PER_LABEL,
  actualCost,
  reserve,
  settle,
  utcDay,
  type BudgetD1,
} from "../src/budget";

/**
 * In-memory stand-in for exactly the three statements src/budget.ts issues.
 * SQL dispatch by substring — these tests pin the DECISION LOGIC (when does
 * reserve fail, how much settle refunds), not D1's SQL engine (covered by the
 * remote smoke below the production deploy).
 */
function fakeD1(initial = 0) {
  const ledger = new Map<string, number>([[utcDay(), initial]]);
  return {
    ledger,
    prepare(sql: string) {
      const bind = (...args: unknown[]) => ({
        async first<T>() {
          if (sql.includes("INSERT INTO")) return null;
          if (sql.includes("UPDATE")) {
            const [cost, day, guardCost] = args as [number, string, number, number?];
            const cap = args.length >= 4 ? (args[3] as number) : Infinity;
            const cur = ledger.get(day) ?? 0;
            if (cur + guardCost > cap) return null;
            const next = cur + cost;
            ledger.set(day, next);
            return { neurons: next } as T;
          }
          const day = args[0] as string;
          return { neurons: ledger.get(day) ?? 0 } as T;
        },
        async run() {
          if (sql.includes("INSERT INTO")) { ledger.set(args[0] as string, ledger.get(args[0] as string) ?? 0); return; }
          // settle refund: MAX(0, neurons - delta)
          const [delta, day] = args as [number, string];
          ledger.set(day, Math.max(0, (ledger.get(day) ?? 0) - delta));
        },
      });
      return { bind }; // shape: db.prepare(sql).bind(...).first()/.run()
    },
  } as unknown as BudgetD1 & { ledger: Map<string, number> };
}

describe("daily neuron budget (Workers AI free tier rate limit)", () => {
  it("reserves and tracks used/left under the cap", async () => {
    const db = fakeD1(0);
    const r = await reserve(db, 3);
    expect(r.ok).toBe(true);
    expect(r.reserved).toBe(3 * RESERVE_PER_LABEL);
    expect(r.used).toBe(3 * RESERVE_PER_LABEL);
    expect(r.left).toBe(DAILY_BUDGET - 3 * RESERVE_PER_LABEL);
  });

  it("fails closed when today's reservation would exceed the cap", async () => {
    const db = fakeD1(DAILY_BUDGET - 50); // nearly exhausted
    const r = await reserve(db, 1);
    expect(r.ok).toBe(false);
    expect(r.reserved).toBe(0);
    expect(r.used).toBe(DAILY_BUDGET - 50);
    expect(r.left).toBe(50);
  });

  it("settle refunds only the unused portion", async () => {
    const db = fakeD1(400);
    await settle(db, 100, 400); // charged 100, reserved 400 → refund 300
    expect(db.ledger.get(utcDay())).toBe(100);
  });

  it("settle is a no-op when actual >= reserved (never claws back overshoot)", async () => {
    const db = fakeD1(400);
    await settle(db, 500, 400);
    expect(db.ledger.get(utcDay())).toBe(400);
  });

  it("utcDay is the calendar date the Workers AI counter resets on (00:00 UTC)", () => {
    expect(utcDay(new Date("2026-09-29T23:59:59Z"))).toBe("2026-09-29");
    expect(utcDay(new Date("2026-09-30T00:00:01Z"))).toBe("2026-09-30");
  });

  it("actualCost applies scout pricelist rates (24,545/M in, 77,273/M out)", () => {
    expect(actualCost(2_100_000, 0)).toBe(51_545); // 2.1M input tokens
    expect(actualCost(0, 1_000_000)).toBe(77_273);
    expect(actualCost(0, 0)).toBe(0);
    expect(actualCost(1, 1)).toBe(1); // floors up, never charges 0 for nonzero usage
  });
});
