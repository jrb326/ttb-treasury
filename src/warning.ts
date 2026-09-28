/**
 * Canonical U.S. alcohol health warning statement (27 CFR part 16 / ABLA 1988).
 * Sourced from TTB, ttb.gov. The "GOVERNMENT WARNING:" heading must be ALL CAPS
 * and bold; the remainder must not be bold; one continuous paragraph.
 *
 * Comparison is case/quote-insensitive (normalize.ts), so extraction verdicts
 * tolerate the CFR's internal capitalization quirks (e.g. "SURGEON GENERAL").
 */

export const WARNING_HEADING = "GOVERNMENT WARNING:";

export const WARNING_BODY =
  "(1) According to the Surgeon General, women should not drink alcoholic beverages " +
  "during pregnancy because of the risk of birth defects. (2) Consumption of alcoholic " +
  "beverages impairs your ability to drive a car or operate machinery, and may cause " +
  "health problems.";