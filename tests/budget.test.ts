import { describe, it, expect } from "vitest";
import {
  DAILY_BUDGET,
  RESERVE_PER_LABEL,
  estimateLabelReserve,
  neuronsFor,
  reserve,
  reserveForImage,
  settle,
  utcDay,
  type BudgetD1,
} from "../src/budget";
import { parseImageDimensions } from "../src/imageSize";

/** First 33 bytes of public/oldtom-pass.png (PNG sig + IHDR) — the exact
 *  bytes a phone upload's header parse consumes; embedded so the test needs
 *  no fs (tsconfig has workers types only, no node:fs typings). */
const FIXTURE_PNG_HEADER =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAyAAAARMCAYAAABh4ffH";

/**
 * In-memory stand-in for exactly the statements src/budget.ts issues.
 * These tests pin the DECISION LOGIC (when reserve fails, how much settle
 * moves, how image size maps to cost). The SQL itself is proven against the
 * remote production D1 — see README "Daily AI-budget rate limit".
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
          const [val, day] = args as [number, string];
          const cur = ledger.get(day) ?? 0;
          // Real D1 settles via two different statements — dispatch on SQL
          // text, NOT the bound sign: refund binds a POSITIVE amount to
          // "MAX(0, neurons - ?)"; overshoot binds delta to "neurons + ?".
          if (sql.includes("MAX(0, neurons - ?)")) ledger.set(day, Math.max(0, cur - val));
          else if (sql.includes("neurons = neurons + ?")) ledger.set(day, cur + val);
        },
      });
      return { bind }; // shape: db.prepare(sql).bind(...).first()/.run()
    },
  } as unknown as BudgetD1 & { ledger: Map<string, number> };
}

describe("daily neuron budget (Workers AI free-tier rate limit)", () => {
  it("books per-image cost and reports used/left under the cap", async () => {
    const db = fakeD1(0);
    const costs = [120, 120, 120];
    const r = await reserve(db, costs);
    expect(r.ok).toBe(true);
    expect(r.reserved).toBe(360);
    expect(r.used).toBe(360);
    expect(r.left).toBe(DAILY_BUDGET - 360);
  });

  it("fails the WHOLE request when one more batch would cross the cap — no model call", async () => {
    const db = fakeD1(DAILY_BUDGET - 50); // nearly exhausted
    const r = await reserve(db, [120]);
    expect(r.ok).toBe(false);
    expect(r.reserved).toBe(0);
    expect(r.used).toBe(DAILY_BUDGET - 50);
    expect(r.left).toBe(50);
  });

  it("refund: settle moves ledger down when actual < reserved", async () => {
    const db = fakeD1(400);
    await settle(db, 100, 400); // charged 100, reserved 400 → refund 300
    expect(db.ledger.get(utcDay())).toBe(100);
  });

  it("Overshoot: settle charges when actual > reserved (ledger never under-reports CF)", async () => {
    const db = fakeD1(400);
    await settle(db, 500, 400); // estimate was low → +100 adjustment
    expect(db.ledger.get(utcDay())).toBe(500);
  });

  it("settle exact match is a no-op", async () => {
    const db = fakeD1(400);
    await settle(db, 400, 400);
    expect(db.ledger.get(utcDay())).toBe(400);
  });

  it("settle refund never goes below zero", async () => {
    const db = fakeD1(30);
    await settle(db, 0, 400);
    expect(db.ledger.get(utcDay())).toBe(0);
  });
});

describe("size-aware reserve", () => {
  it("fixture dimensions → conservative reserve at scout rates (≈2.5k in + 80 out)", () => {
    // 800x1100 fixture: (800*1100/400 + 300) = 2,500 in tokens → 61.4 neurons;
    // +80 out → ~7; floor 120 not hit → value in [61..120] band… assert exact formula
    const r = estimateLabelReserve(800, 1100);
    expect(r).toBeGreaterThan(100);
    expect(r).toBeLessThan(200);
    expect(r).toBeGreaterThanOrEqual(RESERVE_PER_LABEL - 60);
  });

  it("12MP phone photo reserves ≈6× the fixture, not a flat 120", () => {
    const big = estimateLabelReserve(4032, 3024);
    const fix = estimateLabelReserve(800, 1100);
    expect(big).toBeGreaterThan(500);
    expect(big).toBeGreaterThan(fix * 3);
    // and a 10-image batch of such photos must still fit — not auto-429
    expect(Math.min(big, DAILY_BUDGET)).toBeLessThan(DAILY_BUDGET);
  });

  it("unknown dimensions fall back to the flat reserve (never guess big)", () => {
    expect(estimateLabelReserve(null, null)).toBe(RESERVE_PER_LABEL);
    expect(estimateLabelReserve(0, 500)).toBe(RESERVE_PER_LABEL);
  });

  it("reserveForImage reads the ACTUAL fixture header (PNG, real bytes)", () => {
    const r = reserveForImage(FIXTURE_PNG_HEADER);
    expect(r).toBeGreaterThan(RESERVE_PER_LABEL / 2);
    expect(parseImageDimensions(FIXTURE_PNG_HEADER)).toEqual({ width: 800, height: 1100 });
  });
});

describe("neuronsFor (pricelist rates)", () => {
  it("applies scout rates: 24,545/M in, 77,273/M out", () => {
    expect(neuronsFor(2_100_000, 0)).toBe(51_545);
    expect(neuronsFor(0, 1_000_000)).toBe(77_273);
    expect(neuronsFor(0, 0)).toBe(0);
    expect(neuronsFor(1, 1)).toBe(1);
  });

  it("fixture label costs (measured ≈2.2k in / 280 out) land at ≈77 neurons", () => {
    const measured = neuronsFor(2200, 280);
    expect(measured).toBeGreaterThan(70);
    expect(measured).toBeLessThan(90);
  });
});

describe("utcDay / reset window", () => {
  it("matches Workers AI's 00:00 UTC daily reset", () => {
    expect(utcDay(new Date("2026-09-29T23:59:59Z"))).toBe("2026-09-29");
    expect(utcDay(new Date("2026-09-30T00:00:01Z"))).toBe("2026-09-30");
  });
});

describe("parseImageDimensions", () => {
  it("reads PNG IHDR — fixture header bytes, exact dims", () => {
    expect(parseImageDimensions(FIXTURE_PNG_HEADER)).toEqual({ width: 800, height: 1100 });
  });

  it("reads JPEG SOF — synthetic SOI+APP1(EXIF pad)+SOF0 (the JPEG is the common phone-camera path)", () => {
    const w = 4032, h = 3024;
    const soi = [0xff, 0xd8];
    // SOF0: length field counts ITSELF+payload → 2 + 15 payload = 0x0011.
    // (Tag 0x0013 would oversell the 17 bytes present → truncation guard bails.)
    const app1 = [0xff, 0xe1, 0x01, 0x00, ...Array(0xfe).fill(0x00)];
    const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, (h >> 8) & 0xff, h & 0xff, (w >> 8) & 0xff, w & 0xff, 0x03, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11];
    const bytes = Uint8Array.from([...soi, ...app1, ...sof]);
    const b64 = Buffer.from(bytes).toString("base64");
    expect(parseImageDimensions("data:image/jpeg;base64," + b64)).toEqual({ width: w, height: h });
  });

  it("reads WebP VP8X canvas dims", () => {
    const bytes = new Uint8Array(30);
    const put = (o: number, s: string) => { for (let i = 0; i < s.length; i++) bytes[o + i] = s.charCodeAt(i); };
    put(0, "RIFF"); put(8, "WEBP"); put(12, "VP8X");
    bytes[24] = 999 & 0xff; bytes[25] = (999 >> 8) & 0xff; bytes[26] = 0;   // width-1 = 999
    bytes[27] = 699 & 0xff; bytes[28] = (699 >> 8) & 0xff; bytes[29] = 0;   // height-1 = 699
    expect(parseImageDimensions("data:image/webp;base64," + Buffer.from(bytes).toString("base64")))
      .toEqual({ width: 1000, height: 700 });
  });

  it("garbage → null (caller falls back to flat reserve)", () => {
    expect(parseImageDimensions("data:image/unknown;base64," + Buffer.from("not an image!!").toString("base64"))).toBeNull();
    expect(parseImageDimensions("plain not-base64 text")).toBeNull();
  });
});