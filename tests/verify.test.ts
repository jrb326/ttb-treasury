import { describe, it, expect } from "vitest";
import { errorResult, verifyLabel } from "../src/verify";
import { buildRegChecks } from "../src/regulations";
import { WARNING_BODY } from "../src/warning";
import type { Extraction, LabelApplication } from "../src/types";

/** Well-formed extraction with the canonical warning; override per test. */
function ext(overrides: Partial<Extraction> = {}): Extraction {
  return {
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
      body_bold: false,
      contrast_ok: true,
      size_issue: "none",
    },
    regulation_cues: {
      brand_format_issue: "none",
      type_designation_issue: "none",
      alcohol_type_mismatch: "none",
      health_claim: "none",
      disclosure_unverifiable: "none",
      import_status: "domestic",
    },
    ...overrides,
  };
}

const matchingApp: LabelApplication = {
  brandName: "OLD TOM DISTILLERY",
  classType: "Kentucky Straight Bourbon Whiskey",
  alcoholContent: "45% Alc./Vol. (90 Proof)",
  netContents: "750 mL",
};

describe("verifyLabel rollup", () => {
  it("passes when all checked fields match and warning is compliant", () => {
    const r = verifyLabel({ file: "a.png", app: matchingApp, extraction: ext(), latencyMs: 120 });
    expect(r.status).toBe("pass");
    expect(r.fields.brandName.status).toBe("pass");
    expect(r.fields.warning.status).toBe("pass");
  });

  it("flags when alcohol content disagrees beyond tolerance", () => {
    const app = { ...matchingApp, alcoholContent: "50% Alc./Vol." };
    const r = verifyLabel({ file: "a.png", app, extraction: ext(), latencyMs: 1 });
    expect(r.status).toBe("flag");
    expect(r.fields.alcoholContent.status).toBe("flag");
    expect(r.fields.alcoholContent.note).toContain("alcohol content");
  });

  it("flags when a checked field is missing from the label", () => {
    const r = verifyLabel({
      file: "a.png",
      app: matchingApp,
      extraction: ext({ net_contents: "" }),
      latencyMs: 1,
    });
    expect(r.status).toBe("flag");
    expect(r.fields.netContents.status).toBe("missing");
  });

  it("style-only brand difference still passes with a note", () => {
    const app = { ...matchingApp, brandName: "Old Tom Distillery" };
    const r = verifyLabel({ file: "a.png", app, extraction: ext(), latencyMs: 1 });
    expect(r.status).toBe("pass");
    expect(r.fields.brandName.status).toBe("pass");
    expect(r.fields.brandName.note).toContain("style-only");
  });
});

describe("verifyLabel not_checked fields", () => {
  it("empty application fields are not_checked and excluded from rollup", () => {
    const app: LabelApplication = {
      brandName: "OLD TOM DISTILLERY",
      classType: "",
      alcoholContent: "",
      netContents: "",
    };
    const r = verifyLabel({ file: "a.png", app, extraction: ext(), latencyMs: 1 });
    expect(r.fields.classType.status).toBe("not_checked");
    expect(r.fields.alcoholContent.status).toBe("not_checked");
    expect(r.fields.netContents.status).toBe("not_checked");
    expect(r.status).toBe("pass");
    expect(r.summary.some((l) => l.includes("not provided"))).toBe(false);
  });

  it("null application: text fields not_checked, compliant warning still passes", () => {
    const r = verifyLabel({ file: "a.png", app: null, extraction: ext(), latencyMs: 1 });
    expect(r.fields.brandName.status).toBe("not_checked");
    expect(r.fields.classType.status).toBe("not_checked");
    expect(r.fields.alcoholContent.status).toBe("not_checked");
    expect(r.fields.netContents.status).toBe("not_checked");
    expect(r.status).toBe("pass");
  });

  it("null application with absent warning still flags", () => {
    const r = verifyLabel({
      file: "a.png",
      app: null,
      extraction: ext({
        government_warning: { present: false, text: "", heading_as_printed: "", heading_bold: false, body_bold: false, contrast_ok: true, size_issue: "none" },
      }),
      latencyMs: 1,
    });
    expect(r.status).toBe("flag");
    expect(r.fields.warning.status).toBe("missing");
  });
});

describe("verifyLabel warning field", () => {
  it("absent warning is missing with a 27 CFR note", () => {
    const r = verifyLabel({
      file: "a.png",
      app: matchingApp,
      extraction: ext({
        government_warning: { present: false, text: "", heading_as_printed: "", heading_bold: false, body_bold: false, contrast_ok: true, size_issue: "none" },
      }),
      latencyMs: 1,
    });
    expect(r.fields.warning.status).toBe("missing");
    expect(r.fields.warning.note).toContain("27 CFR");
    expect(r.summary.join("\n")).toContain("MISSING \u2014");
  });

  it("non-bold heading flags with formatting note", () => {
    const r = verifyLabel({
      file: "a.png",
      app: matchingApp,
      extraction: ext({
        government_warning: {
          present: true,
          text: WARNING_BODY,
          heading_as_printed: "GOVERNMENT WARNING:",
          heading_bold: false,
          body_bold: false,
          contrast_ok: true,
          size_issue: "none",
        },
      }),
      latencyMs: 1,
    });
    expect(r.status).toBe("flag");
    expect(r.fields.warning.status).toBe("flag");
    expect(r.fields.warning.note).toContain("bold");
  });

  it("mismatched warning body flags as differing verbatim text", () => {
    const r = verifyLabel({
      file: "a.png",
      app: matchingApp,
      extraction: ext({
        government_warning: {
          present: true,
          text: "Drink responsibly and stay hydrated every day.",
          heading_as_printed: "GOVERNMENT WARNING:",
          heading_bold: true,
          body_bold: false,
          contrast_ok: true,
          size_issue: "none",
        },
      }),
      latencyMs: 1,
    });
    expect(r.fields.warning.status).toBe("flag");
    expect(r.fields.warning.note).toContain("verbatim");
  });

  it("flags VLM-reported warning microprint (16.22(b))", () => {
    const r = verifyLabel({
      file: "a.png",
      app: matchingApp,
      extraction: ext({
        government_warning: {
          present: true,
          text: WARNING_BODY,
          heading_as_printed: "GOVERNMENT WARNING:",
          heading_bold: true,
          body_bold: false,
          contrast_ok: true,
          size_issue: "microprint, body unreadable",
        },
      }),
      latencyMs: 1,
    });
    expect(r.status).toBe("flag");
    expect(r.fields.warning.note).toContain("16.22(b)");
    expect(r.fields.warning.note).toContain("microprint");
  });

  it("passes type size when the model cannot tell (unknown → no claim)", () => {
    const r = verifyLabel({
      file: "a.png",
      app: matchingApp,
      extraction: ext({
        government_warning: {
          present: true,
          text: WARNING_BODY,
          heading_as_printed: "GOVERNMENT WARNING:",
          heading_bold: true,
          body_bold: false,
          contrast_ok: true,
          size_issue: "unknown",
        },
      }),
      latencyMs: 1,
    });
    expect(r.fields.warning.status).toBe("pass");
  });

  it("flags body text printed bold (16.22(a)(2))", () => {
    const r = verifyLabel({
      file: "a.png",
      app: matchingApp,
      extraction: ext({
        government_warning: {
          present: true,
          text: WARNING_BODY,
          heading_as_printed: "GOVERNMENT WARNING:",
          heading_bold: true,
          body_bold: true,
          contrast_ok: true,
          size_issue: "none",
        },
      }),
      latencyMs: 1,
    });
    expect(r.status).toBe("flag");
    expect(r.fields.warning.note).toContain("must NOT be bold");
  });
});

describe("verifyLabel bottler (27 CFR 5.63(b))", () => {
  it("only checked when application provides it", () => {
    const without = verifyLabel({ file: "a.png", app: matchingApp, extraction: ext(), latencyMs: 1 });
    expect(without.fields.bottler).toBeUndefined();

    const app = { ...matchingApp, bottler: "Old Tom Distillery, Louisville KY" };
    const match = verifyLabel({ file: "a.png", app, extraction: ext(), latencyMs: 1 });
    expect(match.fields.bottler?.status).toBe("pass");

    const missing = verifyLabel({ file: "a.png", app, extraction: ext({ bottler: "" }), latencyMs: 1 });
    expect(missing.fields.bottler?.status).toBe("missing");
    expect(missing.status).toBe("flag");
  });
});

describe("verifyLabel country of origin", () => {
  it("only checked when application provides it", () => {
    const without = verifyLabel({ file: "a.png", app: matchingApp, extraction: ext(), latencyMs: 1 });
    expect(without.fields.countryOfOrigin).toBeUndefined();

    const app = { ...matchingApp, countryOfOrigin: "United States" };
    const withCountry = verifyLabel({
      file: "a.png",
      app,
      extraction: ext({ country_of_origin: "CANADA" }),
      latencyMs: 1,
    });
    expect(withCountry.fields.countryOfOrigin?.status).toBe("flag");
    expect(withCountry.status).toBe("flag");
  });
});

describe("verifyLabel summary", () => {
  it("uses check-mark for plain passes and FLAG/MISSING prefixes otherwise", () => {
    const r = verifyLabel({ file: "a.png", app: matchingApp, extraction: ext(), latencyMs: 1 });
    expect(r.summary).toContain("brand name: match \u2713");
    expect(r.summary.every((l) => !l.includes("FLAG \u2014") && !l.includes("MISSING \u2014"))).toBe(true);

    const flagged = verifyLabel({
      file: "a.png",
      app: matchingApp,
      extraction: ext({ brand_name: "", net_contents: "1 L" }),
      latencyMs: 1,
    });
    expect(flagged.summary).toContain("brand name: MISSING \u2014 Brand name not found on label");
    expect(flagged.summary.some((l) => l.startsWith("net contents: FLAG \u2014"))).toBe(true);
  });

  it("unreadable image prepends a warning line", () => {
    const r = verifyLabel({
      file: "a.png",
      app: matchingApp,
      extraction: ext({ readability: { readable: false, issues: ["glare", "blur"] } }),
      latencyMs: 1,
    });
    expect(r.status).toBe("pass"); // readability alone does not flag fields
    expect(r.summary[0]).toContain("unreadable");
    expect(r.summary[0]).toContain("glare; blur");
  });
});

describe("buildRegChecks", () => {
  it("returns one row per rule, all clean on a compliant extraction", () => {
    const checks = buildRegChecks(ext());
    expect(checks.length).toBe(10);
    expect(checks.every((c) => c.status === "pass")).toBe(true);
    expect(checks.find((c) => c.id === "brand_present")?.citation).toContain("5.64");
    expect(checks.find((c) => c.id === "warning_format")?.citation).toContain("16.22(a)");
  });

  it("flags VLM-reported health claims (27 CFR 5.62(f))", () => {
    const checks = buildRegChecks(
      ext({
        regulation_cues: {
          brand_format_issue: "none",
          type_designation_issue: "none",
          alcohol_type_mismatch: "none",
          health_claim: "\u201cthe cure for stress\u201d printed under the brand",
          disclosure_unverifiable: "none",
          import_status: "domestic",
        },
      }),
    );
    const health = checks.find((c) => c.id === "no_health_claim");
    expect(health?.status).toBe("flag");
    expect(health?.detail).toContain("cure for stress");
    // and it rolls up
    const r = verifyLabel({ file: "a.png", app: matchingApp, extraction: ext({
      regulation_cues: {
        brand_format_issue: "none",
        type_designation_issue: "none",
        alcohol_type_mismatch: "none",
        health_claim: "medical claim printed on the back label",
        disclosure_unverifiable: "none",
        import_status: "domestic",
      },
    }), latencyMs: 1 });
    expect(r.status).toBe("flag");
    expect(r.regulations?.find((c) => c.id === "no_health_claim")?.status).toBe("flag");
  });

  it("marks unknown cues as not_checked (no claim) instead of flagging", () => {
    const checks = buildRegChecks(
      ext({
        regulation_cues: {
          brand_format_issue: "unknown",
          type_designation_issue: "unknown",
          alcohol_type_mismatch: "none",
          health_claim: "unknown",
          disclosure_unverifiable: "unknown",
          import_status: "unknown",
        },
      }),
    );
    expect(checks.find((c) => c.id === "brand_format")?.status).toBe("not_checked");
    expect(checks.find((c) => c.id === "import_contract")?.status).toBe("not_checked");
    const r = verifyLabel({ file: "a.png", app: matchingApp, extraction: ext({
      regulation_cues: {
        brand_format_issue: "unknown",
        type_designation_issue: "unknown",
        alcohol_type_mismatch: "none",
        health_claim: "unknown",
        disclosure_unverifiable: "unknown",
        import_status: "unknown",
      },
    }), latencyMs: 1 });
    expect(r.status).toBe("pass"); // unknown never flags
  });

  it("missing warning block reported missing in checklist", () => {
    const checks = buildRegChecks(
      ext({
        government_warning: { present: false, text: "", heading_as_printed: "", heading_bold: false, body_bold: false, contrast_ok: true, size_issue: "none" },
      }),
    );
    expect(checks.find((c) => c.id === "warning_present")?.status).toBe("missing");
    expect(checks.find((c) => c.id === "warning_format")?.status).toBe("missing");
  });

  it("import rules: foreign label with full data passes, missing origin flags", () => {
    const base = {
      regulation_cues: {
        brand_format_issue: "none",
        type_designation_issue: "none",
        alcohol_type_mismatch: "none",
        health_claim: "none",
        disclosure_unverifiable: "none",
        import_status: "imported" as const,
      },
    };
    const ok = buildRegChecks(ext({ ...base, country_of_origin: "Scotland", bottler: "Imported by Acme, NY" }));
    expect(ok.find((c) => c.id === "import_contract")?.status).toBe("pass");

    const noOrigin = buildRegChecks(ext({ ...base, country_of_origin: "", bottler: "Imported by Acme, NY" }));
    expect(noOrigin.find((c) => c.id === "import_contract")?.status).toBe("missing");
  });
});

describe("errorResult", () => {
  it("surfaces error status and message", () => {
    const r = errorResult("bad.jpg", "model timeout", 4321);
    expect(r.status).toBe("error");
    expect(r.file).toBe("bad.jpg");
    expect(r.latencyMs).toBe(4321);
    expect(r.summary.join(" ")).toContain("model timeout");
    expect(Object.values(r.fields).every((f) => f.status === "error")).toBe(true);
  });
});
