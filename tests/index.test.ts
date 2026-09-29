import { describe, it, expect, vi, afterEach } from "vitest";
import worker from "../src/index";
import { WARNING_BODY } from "../src/warning";

/** Contract: clients chunk at 10 items/request and the server rejects >10. */
const MAX_ITEMS_PER_REQUEST = 10;

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** Fixed extraction the mock siteverify + mocked chat path returns for every image. */
const MODEL_EXTRACTION = {
  readability: { readable: true, issues: [] },
  brand_name: "OLD TOM DISTILLERY",
  class_type: "Kentucky Straight Bourbon Whiskey",
  alcohol_content: "45% Alc./Vol. (90 Proof)",
  net_contents: "750 mL",
  bottler: "Old Tom Distillery, Louisville KY",
  country_of_origin: "",
  government_warning: {
    present: true,
    text: WARNING_BODY,
    heading_as_printed: "GOVERNMENT WARNING:",
    heading_bold: true,
  },
};

function makeEnv() {
  const chat = {
    complete: vi.fn(async () => JSON.stringify(MODEL_EXTRACTION)),
  };
  const assetsFetch = vi.fn(async () => new Response("asset"));
  const env = {
    CF_ACCOUNT_ID: "acct",
    AGENT_AI_TOKEN: "tok",
    CHAT: chat as unknown as { complete: (c: unknown, o?: unknown) => Promise<string> },
    ASSETS: { fetch: assetsFetch },
    TURNSTILE_SECRET: "test",
    TURNSTILE_HOSTNAMES: "localhost",
  };
  return { env, chat, assetsFetch };
}

/** Stub global fetch used by siteverify; returns the given verdict JSON. */
function stubSiteverify(result: Record<string, unknown>, ok = true) {
  const fn = vi.fn(async () => ({ ok, json: async () => result }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

const VALID_SITEVERIFY = { success: true, action: "verify", hostname: "localhost" };

function verifyRequest(body: unknown): Request {
  return new Request("http://localhost/api/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const matchingApp = {
  brandName: "OLD TOM DISTILLERY",
  classType: "Kentucky Straight Bourbon Whiskey",
  alcoholContent: "45% Alc./Vol. (90 Proof)",
  netContents: "750 mL",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("static assets", () => {
  it("forwards non-/api GETs to ASSETS without touching AI", async () => {
    const { env, chat, assetsFetch } = makeEnv();
    const res = await worker.fetch(new Request("http://localhost/index.html"), env);
    expect(assetsFetch).toHaveBeenCalledTimes(1);
    expect(chat.complete).not.toHaveBeenCalled();
    expect(await res.text()).toBe("asset");
  });
});

describe("method handling", () => {
  it("GET /api/verify is 405 before any turnstile/AI work", async () => {
    const { env, assetsFetch } = makeEnv();
    const res = await worker.fetch(new Request("http://localhost/api/verify"), env);
    expect(res.status).toBe(405);
    expect(assetsFetch).not.toHaveBeenCalled();
    expect(((await res.json()) as { error: string }).error).toMatch(/not allowed/);
  });
});

describe("turnstile gate", () => {
  it("rejects when siteverify says success=false: 403, AI never called", async () => {
    const siteverify = stubSiteverify({ success: false });
    const { env, chat } = makeEnv();
    const res = await worker.fetch(
      verifyRequest({
        items: [{ file: "a.png", image: "data:image/png;base64,AAAA", app: matchingApp }],
        turnstile: { token: "tok" },
      }),
      env,
    );
    expect(res.status).toBe(403);
    expect(siteverify).toHaveBeenCalledWith(SITEVERIFY_URL, expect.anything());
    const body = (await res.json()) as { error: string; reason: string };
    expect(body.error).toBe("BOT_CHECK_FAILED");
    expect(chat.complete).not.toHaveBeenCalled();
  });

  it("rejects a missing token without even calling siteverify", async () => {
    const siteverify = stubSiteverify(VALID_SITEVERIFY);
    const { env, chat } = makeEnv();
    const res = await worker.fetch(
      verifyRequest({ items: [{ file: "a.png", image: "data:image/png;base64,AAAA" }] }),
      env,
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { reason: string }).reason).toMatch(/token/);
    expect(siteverify).not.toHaveBeenCalled();
    expect(chat.complete).not.toHaveBeenCalled();
  });

  it("rejects a hostname outside TURNSTILE_HOSTNAMES", async () => {
    stubSiteverify({ success: true, action: "verify", hostname: "evil.example" });
    const { env, chat } = makeEnv();
    const res = await worker.fetch(
      verifyRequest({
        items: [{ file: "a.png", image: "data:image/png;base64,AAAA" }],
        turnstile: { token: "tok" },
      }),
      env,
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { reason: string }).reason).toMatch(/hostname/);
    expect(chat.complete).not.toHaveBeenCalled();
  });
});

describe("POST /api/verify happy path", () => {
  it("returns pass when the label matches the application", async () => {
    stubSiteverify(VALID_SITEVERIFY);
    const { env, chat } = makeEnv();
    const res = await worker.fetch(
      verifyRequest({
        items: [{ file: "oldtom.png", image: "data:image/png;base64,AAAA", app: matchingApp }],
        turnstile: { token: "tok" },
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    const { results } = (await res.json()) as { results: Array<{ file: string; status: string }> };
    expect(results).toHaveLength(1);
    expect(results[0].file).toBe("oldtom.png");
    expect(results[0].status).toBe("pass");
    expect(chat.complete).toHaveBeenCalledTimes(1);
  });

  it("returns flag when the application ABV disagrees with the label", async () => {
    stubSiteverify(VALID_SITEVERIFY);
    const { env } = makeEnv();
    const res = await worker.fetch(
      verifyRequest({
        items: [
          {
            file: "oldtom.png",
            image: "data:image/png;base64,AAAA",
            app: { ...matchingApp, alcoholContent: "50%" },
          },
        ],
        turnstile: { token: "tok" },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const { results } = (await res.json()) as { results: Array<{ status: string }> };
    expect(results[0].status).toBe("flag");
  });

  it("null app yields not_checked text fields but still a pass", async () => {
    stubSiteverify(VALID_SITEVERIFY);
    const { env } = makeEnv();
    const res = await worker.fetch(
      verifyRequest({
        items: [{ file: "bare.png", image: "https://example.com/l.png" }],
        turnstile: { token: "tok" },
      }),
      env,
    );
    const { results } = (await res.json()) as {
      results: Array<{ status: string; fields: Record<string, { status: string }>; extraction: { brand_name: string; net_contents: string } | null }>;
    };
    expect(results[0].status).toBe("pass");
    expect(results[0].fields.brandName.status).toBe("not_checked");
    // Extraction is the deliverable: prefills the form even with no filed values.
    expect(results[0].extraction).not.toBeNull();
    expect(results[0].extraction?.brand_name).toBe("OLD TOM DISTILLERY");
    expect(results[0].extraction?.net_contents).toBe("750 mL");
  });
});

describe("request validation", () => {
  it("rejects more than MAX_ITEMS_PER_REQUEST items", async () => {
    stubSiteverify(VALID_SITEVERIFY);
    const { env, chat } = makeEnv();
    const items = Array.from({ length: MAX_ITEMS_PER_REQUEST + 1 }, (_, i) => ({
      file: `i${i}.png`,
      image: "data:image/png;base64,AAAA",
    }));
    const res = await worker.fetch(verifyRequest({ items, turnstile: { token: "tok" } }), env);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/too many items/);
    expect(chat.complete).not.toHaveBeenCalled();
  });

  it("rejects a JSON body without items[]", async () => {
    stubSiteverify(VALID_SITEVERIFY);
    const { env } = makeEnv();
    const res = await worker.fetch(verifyRequest({ turnstile: { token: "tok" } }), env);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/items/);
  });

  it("rejects an item missing its image", async () => {
    stubSiteverify(VALID_SITEVERIFY);
    const { env } = makeEnv();
    const res = await worker.fetch(
      verifyRequest({ items: [{ file: "a.png" }], turnstile: { token: "tok" } }),
      env,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/items\[0\]/);
  });
});
