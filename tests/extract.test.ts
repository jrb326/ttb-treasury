import { describe, it, expect } from "vitest";
import { coerceExtraction, parseModelJson } from "../src/extract";

describe("coerceExtraction defaults", () => {
  it("fills empty strings and readable=true for a bare object", () => {
    const e = coerceExtraction({});
    expect(e.readability).toEqual({ readable: true, issues: [] });
    expect(e.brand_name).toBe("");
    expect(e.class_type).toBe("");
    expect(e.alcohol_content).toBe("");
    expect(e.net_contents).toBe("");
    expect(e.bottler).toBe("");
    expect(e.country_of_origin).toBe("");
    expect(e.government_warning).toEqual({
      present: false,
      text: "",
      heading_as_printed: "",
      heading_bold: false,
      body_bold: false,
      contrast_ok: true,
      type_size_mm: null,
    });
  });

  it("tolerates non-object input entirely", () => {
    expect(coerceExtraction(null).brand_name).toBe("");
    expect(coerceExtraction("garbage").readability.readable).toBe(true);
  });

  it("only explicit readable:false marks unreadable; keeps string issues only", () => {
    const e = coerceExtraction({
      readability: { readable: false, issues: ["glare", 42, null, "blur"] },
    });
    expect(e.readability).toEqual({ readable: false, issues: ["glare", "blur"] });

    const truthy = coerceExtraction({ readability: { readable: "yes" } });
    expect(truthy.readability.readable).toBe(true);
  });

  it("warning flags require strict true", () => {
    const e = coerceExtraction({
      government_warning: { present: "true", heading_bold: 1, text: " body ", heading_as_printed: " GOV " },
    });
    expect(e.government_warning.present).toBe(false);
    expect(e.government_warning.heading_bold).toBe(false);
    expect(e.government_warning.text).toBe("body");
    expect(e.government_warning.heading_as_printed).toBe("GOV");
  });

  it("blank strings coerce to empty defaults", () => {
    const e = coerceExtraction({ brand_name: "   ", class_type: 12 });
    expect(e.brand_name).toBe("");
    expect(e.class_type).toBe("");
  });
});

describe("parseModelJson", () => {
  it("parses a plain object", () => {
    expect(parseModelJson('{"a":1}')).toEqual({ a: 1 });
  });

  it("strips ```json fences and prose around the object", () => {
    const text = 'Sure! Here you go:\n```json\n{"brand_name":"OLD TOM"}\n```\nHope that helps.';
    expect(parseModelJson(text)).toEqual({ brand_name: "OLD TOM" });
  });

  it("grabs first { through last }", () => {
    expect(parseModelJson('prefix noise {"a":{"b":2}} trailing suffix')).toEqual({ a: { b: 2 } });
  });

  it("throws when there is no JSON object", () => {
    expect(() => parseModelJson("no braces here")).toThrow(/no JSON object/);
    expect(() => parseModelJson("} {")).toThrow(/no JSON object/);
  });

  it("throws on malformed JSON inside braces", () => {
    expect(() => parseModelJson("{oops}")).toThrow();
  });
});
