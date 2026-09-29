import { describe, it, expect } from "vitest";
import {
  compareWarning,
  matchAbv,
  matchNetContents,
  matchText,
  normalize,
  parseAbv,
  parseVolume,
  wordSetSimilarity,
} from "../src/normalize";
import { WARNING_BODY } from "../src/warning";

describe("normalize", () => {
  it("folds case, apostrophes, punctuation, whitespace", () => {
    expect(normalize("  Stone\u2019s  THROW!! ")).toBe("stones throw");
    expect(normalize("STONE'S THROW")).toBe(normalize("Stone's Throw"));
  });

  it("strips diacritics via NFKD", () => {
    expect(normalize("Café  NOËL")).toBe("cafe noel");
  });

  it("keeps digits, %, . and / ", () => {
    expect(normalize("45% Alc./Vol.")).toBe("45% alc./vol.");
  });
});

describe("matchText", () => {
  it("exact for identical strings", () => {
    expect(matchText("OLD TOM DISTILLERY", "OLD TOM DISTILLERY")).toBe("exact");
  });

  it("style_only for case/punctuation-only differences", () => {
    expect(matchText("Stone's Throw", "STONE'S THROW")).toBe("style_only");
    expect(matchText("OLD TOM DISTILLERY", "Old Tom Distillery")).toBe("style_only");
  });

  it("similar via 6-word path (maxEdits=0, word-set sim \u2265 0.8)", () => {
    expect(matchText("a b c d e f", "a b c d e g")).toBe("similar");
  });

  it("similar via generic path (word-set sim exactly 0.8)", () => {
    expect(matchText("750 ml 86 proof import", "750 ml 90 proof import")).toBe("similar");
  });

  it("mismatch for unrelated text", () => {
    expect(matchText("750 mL", "SMALL BATCH")).toBe("mismatch");
  });

  it("mismatch when either side is empty", () => {
    expect(matchText("", "abc")).toBe("mismatch");
    expect(matchText("abc", "   ")).toBe("mismatch");
  });

  it("warning body with one word changed is similar, not mismatch", () => {
    const altered = WARNING_BODY.replace(" a car ", " an auto ");
    expect(matchText(WARNING_BODY, altered)).toBe("similar");
  });

  it("warning body case-shuffled is style_only", () => {
    expect(matchText(WARNING_BODY, WARNING_BODY.toLowerCase())).toBe("style_only");
  });
});

describe("wordSetSimilarity", () => {
  it("returns exactly 0.8 at the similar threshold boundary", () => {
    expect(wordSetSimilarity("a b c d e", "a b c d f")).toBeCloseTo(0.8, 10);
  });

  it("1 for identical word bags regardless of order", () => {
    expect(wordSetSimilarity("a b c", "c b a")).toBe(1);
  });

  it("0 for disjoint bags", () => {
    expect(wordSetSimilarity("a b", "c d")).toBe(0);
  });
});

describe("parseAbv", () => {
  it("extracts both pct and proof from combined text", () => {
    expect(parseAbv("45% Alc./Vol. (90 Proof)")).toEqual({ pct: 45, proof: 90 });
  });

  it("returns nulls when unparseable", () => {
    expect(parseAbv("cask strength")).toEqual({ pct: null, proof: null });
  });
});

describe("matchAbv", () => {
  it("unifies proof/2: 45% ABV matches 90 proof exactly", () => {
    expect(matchAbv("45% Alc./Vol. (90 Proof)", "90 PROOF")).toBe("exact");
  });

  it("tolerates exactly 0.5% ABV difference (boundary)", () => {
    expect(matchAbv("45% Alc./Vol.", "45.5% Alc./Vol.")).toBe("exact");
  });

  it("rejects more than 0.5% ABV difference", () => {
    expect(matchAbv("45% Alc./Vol.", "46% Alc./Vol.")).toBe("mismatch");
    expect(matchAbv("45% Alc./Vol.", "50% Alc./Vol.")).toBe("mismatch");
  });

  it("falls back to matchText when neither side parses", () => {
    expect(matchAbv("Cask Strength", "CASK STRENGTH")).toBe("style_only");
  });
});

describe("parseVolume", () => {
  it("converts liters to milliliters", () => {
    expect(parseVolume("1.5 L")).toEqual({ ml: 1500 });
    expect(parseVolume("9 L")).toEqual({ ml: 9000 });
  });

  it("parses mL", () => {
    expect(parseVolume("750 mL")).toEqual({ ml: 750 });
  });

  it("returns null for non-volumes", () => {
    expect(parseVolume("not a volume")).toBeNull();
  });
});

describe("matchNetContents", () => {
  it("exact across unit conversion (750 mL == 0.75 L)", () => {
    expect(matchNetContents("750 mL", "0.75 L")).toBe("exact");
  });

  it("case-insensitive unit parse is exact", () => {
    expect(matchNetContents("750 ML", "750 mL")).toBe("exact");
  });

  it("mismatch for different volumes", () => {
    expect(matchNetContents("750 mL", "1 L")).toBe("mismatch");
  });

  it("falls back to matchText when unparseable", () => {
    expect(matchNetContents("one quart", "ONE QUART")).toBe("style_only");
  });
});

describe("compareWarning", () => {
  it("canonical body + ALL CAPS heading + bold passes fully", () => {
    const r = compareWarning(WARNING_BODY, "GOVERNMENT WARNING:", true);
    expect(r.textMatch).not.toBe("mismatch");
    expect(r.headingPass).toBe(true);
    expect(r.headingNotice).toBeNull();
  });

  it("tolerates case-shuffled body (style_only)", () => {
    const r = compareWarning(WARNING_BODY.toLowerCase(), "GOVERNMENT WARNING:", true);
    expect(r.textMatch).toBe("style_only");
    expect(r.headingPass).toBe(true);
  });

  it("heading missing the colon fails with an ALL CAPS notice", () => {
    const r = compareWarning(WARNING_BODY, "Government Warning", true);
    expect(r.headingPass).toBe(false);
    expect(r.headingNotice).toContain("ALL CAPS");
  });

  it("non-bold heading fails with a bold notice", () => {
    const r = compareWarning(WARNING_BODY, "GOVERNMENT WARNING:", false);
    expect(r.headingPass).toBe(false);
    expect(r.headingNotice).toContain("bold");
  });

  it("bold body text after the heading fails (27 CFR 16.22(a)(2))", () => {
    const r = compareWarning(WARNING_BODY, "GOVERNMENT WARNING:", true, true);
    expect(r.headingPass).toBe(false);
    expect(r.headingNotice).toContain("must NOT be bold");
  });
});

describe("compareWarning heading-in-body tolerance", () => {
  it("exact body plus a leading heading stamp matches exactly", () => {
    const r = compareWarning(
      "GOVERNMENT WARNING: " + WARNING_BODY,
      "GOVERNMENT WARNING:",
      true,
    );
    expect(r.textMatch).toBe("exact");
    expect(r.headingPass).toBe(true);
  });
  it("heading stamp without colon still counts", () => {
    const r = compareWarning("GOVERNMENT WARNING " + WARNING_BODY, "GOVERNMENT WARNING:", true);
    expect(r.textMatch).toBe("exact");
  });
  it("tampered text with heading still fails as mismatch", () => {
    const r = compareWarning("GOVERNMENT WARNING: drink responsibly daily.", "GOVERNMENT WARNING:", true);
    expect(["similar", "mismatch"]).toContain(r.textMatch);
  });
});
