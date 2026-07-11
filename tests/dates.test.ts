import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractDate, stripMatch } from "../src/engine/dates.js";

// Fixed anchor for every test: Monday, July 6, 2026 (local time).
const MONDAY = new Date(2026, 6, 6, 9, 30);

function dateOf(text: string, now: Date = MONDAY): string | null {
  return extractDate(text, now)?.date ?? null;
}

describe("extractDate — relative day words", () => {
  it("resolves today and tonight to the anchor day", () => {
    assert.equal(dateOf("file expenses today"), "2026-07-06");
    assert.equal(dateOf("take out trash tonight"), "2026-07-06");
  });

  it("resolves tomorrow and its abbreviations", () => {
    assert.equal(dateOf("call dentist tomorrow"), "2026-07-07");
    assert.equal(dateOf("call dentist tmrw"), "2026-07-07");
    assert.equal(dateOf("call dentist tmr"), "2026-07-07");
  });

  it("resolves day after tomorrow (not the inner 'tomorrow')", () => {
    const match = extractDate("water plants day after tomorrow", MONDAY);
    assert.equal(match?.date, "2026-07-08");
    assert.match(match!.text, /day\s+after\s+tomorrow/i);
  });
});

describe("extractDate — 'in N units'", () => {
  it("handles day, week, and month offsets", () => {
    assert.equal(dateOf("renew passport in 3 days"), "2026-07-09");
    assert.equal(dateOf("dentist in 2 weeks"), "2026-07-20");
    assert.equal(dateOf("rotate tires in 1 month"), "2026-08-06");
  });

  it("handles the articles 'a' and 'an'", () => {
    assert.equal(dateOf("follow up in a week"), "2026-07-13");
    assert.equal(dateOf("check back in a day"), "2026-07-07");
  });

  it("month offsets roll over year boundaries", () => {
    assert.equal(dateOf("review lease in 6 months"), "2027-01-06");
  });
});

describe("extractDate — weekdays", () => {
  it("bare/this/on weekday = soonest occurrence", () => {
    assert.equal(dateOf("pay rent friday"), "2026-07-10");
    assert.equal(dateOf("pay rent on friday"), "2026-07-10");
    assert.equal(dateOf("pay rent this friday"), "2026-07-10");
    assert.equal(dateOf("pay rent fri"), "2026-07-10");
  });

  it("soonest occurrence includes today", () => {
    assert.equal(dateOf("standup notes monday"), "2026-07-06");
  });

  it("next weekday = soonest occurrence + 7", () => {
    assert.equal(dateOf("book flights next friday"), "2026-07-17");
    assert.equal(dateOf("laundry next monday"), "2026-07-13");
  });
});

describe("extractDate — week and month anchors", () => {
  it("next week = next Monday", () => {
    assert.equal(dateOf("plan sprint next week"), "2026-07-13");
  });

  it("end of week / eow = this week's Sunday", () => {
    assert.equal(dateOf("submit timesheet end of week"), "2026-07-12");
    assert.equal(dateOf("submit timesheet by eow"), "2026-07-12");
    // From a Sunday, end of week is that same day.
    assert.equal(dateOf("wrap up eow", new Date(2026, 6, 12)), "2026-07-12");
  });

  it("end of month / eom = last day of current month", () => {
    assert.equal(dateOf("invoice client end of month"), "2026-07-31");
    assert.equal(dateOf("invoice client eom"), "2026-07-31");
    // February, non-leap year.
    assert.equal(dateOf("close books eom", new Date(2026, 1, 10)), "2026-02-28");
  });

  it("next month = first of next month", () => {
    assert.equal(dateOf("switch plans next month"), "2026-08-01");
    // December rolls into January of next year.
    assert.equal(dateOf("switch plans next month", new Date(2026, 11, 15)), "2027-01-01");
  });
});

describe("extractDate — span selection and stripping", () => {
  it("returns null when nothing matches", () => {
    assert.equal(dateOf("buy milk"), null);
  });

  it("includes the leading preposition in the matched span", () => {
    const match = extractDate("pay rent by friday", MONDAY)!;
    assert.equal(match.text, "by friday");
    assert.equal(stripMatch("pay rent by friday", match), "pay rent");
  });

  it("earliest match wins when several expressions appear", () => {
    const match = extractDate("tomorrow buy tickets for friday show", MONDAY)!;
    assert.equal(match.date, "2026-07-07");
  });

  it("stripMatch tidies mid-sentence removals", () => {
    const match = extractDate("call mom tomorrow about the trip", MONDAY)!;
    assert.equal(stripMatch("call mom tomorrow about the trip", match), "call mom about the trip");
  });

  it("does not fire on words that merely contain a keyword", () => {
    assert.equal(dateOf("read the sunset photography book"), null);
    assert.equal(dateOf("buy fridge magnets"), null);
  });
});
