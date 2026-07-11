/**
 * Phase 1a — Deterministic relative-date extraction.
 *
 * Pure functions, zero dependencies, no locale APIs beyond Date arithmetic.
 * All resolution is relative to an explicit `now` so results are fully
 * deterministic and unit-testable. Dates are returned as local-calendar
 * ISO day strings (YYYY-MM-DD); time-of-day is out of scope for now.
 *
 * Design decisions (see README for the open questions on these):
 *  - "friday" / "this friday" / "on friday" = soonest occurrence, today included.
 *  - "next friday"                          = that occurrence + 7 days.
 *  - Week starts Monday; "end of week" = this week's Sunday.
 */

export interface DateMatch {
  /** Resolved due date as a local YYYY-MM-DD string. */
  date: string;
  /** Index of the first matched character in the input (includes any leading preposition). */
  start: number;
  /** Index one past the last matched character. */
  end: number;
  /** The exact matched text, e.g. "by next friday". */
  text: string;
}

const WEEKDAYS = [
  ["sunday", "sun"],
  ["monday", "mon"],
  ["tuesday", "tue", "tues"],
  ["wednesday", "wed", "weds"],
  ["thursday", "thu", "thur", "thurs"],
  ["friday", "fri"],
  ["saturday", "sat"],
] as const;

const WEEKDAY_PATTERN = WEEKDAYS.map((names) => names.join("|")).join("|");

/** Optional preposition folded into the match span so title-stripping removes it too. */
const PREP = String.raw`(?:\b(?:by|on|due|before|until)\s+)?`;

function weekdayIndex(name: string): number {
  const lower = name.toLowerCase();
  return WEEKDAYS.findIndex((names) => (names as readonly string[]).includes(lower));
}

function addDays(base: Date, days: number): Date {
  return new Date(base.getFullYear(), base.getMonth(), base.getDate() + days);
}

function toDayString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Days until the soonest occurrence of `weekday` (0 if `now` already is that weekday). */
function daysUntilWeekday(now: Date, weekday: number): number {
  return (weekday - now.getDay() + 7) % 7;
}

interface Rule {
  regex: RegExp;
  resolve: (match: RegExpExecArray, now: Date) => Date;
}

const UNIT_DAYS: Record<string, (now: Date, n: number) => Date> = {
  day: (now, n) => addDays(now, n),
  week: (now, n) => addDays(now, n * 7),
  month: (now, n) => new Date(now.getFullYear(), now.getMonth() + n, now.getDate()),
};

/**
 * Rules are all run against the full input; overlaps are settled by pick order
 * (earliest start wins, longest match breaks ties), so e.g. "day after tomorrow"
 * beats the bare "tomorrow" inside it.
 */
const RULES: Rule[] = [
  {
    regex: new RegExp(String.raw`${PREP}\bday\s+after\s+tomorrow\b`, "gi"),
    resolve: (_m, now) => addDays(now, 2),
  },
  {
    regex: new RegExp(String.raw`${PREP}\b(?:tomorrow|tmrw|tmr)\b`, "gi"),
    resolve: (_m, now) => addDays(now, 1),
  },
  {
    regex: new RegExp(String.raw`${PREP}\b(?:today|tonight)\b`, "gi"),
    resolve: (_m, now) => addDays(now, 0),
  },
  {
    regex: new RegExp(String.raw`${PREP}\bin\s+(\d{1,3}|a|an)\s+(day|week|month)s?\b`, "gi"),
    resolve: (m, now) => {
      const raw = m[1]!.toLowerCase();
      const n = raw === "a" || raw === "an" ? 1 : parseInt(raw, 10);
      return UNIT_DAYS[m[2]!.toLowerCase()]!(now, n);
    },
  },
  {
    regex: new RegExp(String.raw`${PREP}\bnext\s+week\b`, "gi"),
    // Next Monday (week starts Monday).
    resolve: (_m, now) => addDays(now, ((1 - now.getDay() + 7) % 7) || 7),
  },
  {
    regex: new RegExp(String.raw`${PREP}\bnext\s+month\b`, "gi"),
    resolve: (_m, now) => new Date(now.getFullYear(), now.getMonth() + 1, 1),
  },
  {
    regex: new RegExp(String.raw`${PREP}\bnext\s+(${WEEKDAY_PATTERN})\b`, "gi"),
    resolve: (m, now) => addDays(now, daysUntilWeekday(now, weekdayIndex(m[1]!)) + 7),
  },
  {
    regex: new RegExp(String.raw`${PREP}\b(?:this\s+)?(${WEEKDAY_PATTERN})\b`, "gi"),
    resolve: (m, now) => addDays(now, daysUntilWeekday(now, weekdayIndex(m[1]!))),
  },
  {
    regex: new RegExp(String.raw`${PREP}\b(?:end\s+of\s+(?:the\s+)?week|eow)\b`, "gi"),
    // This week's Sunday: 0 days if today is Sunday, else days until the coming Sunday.
    resolve: (_m, now) => addDays(now, daysUntilWeekday(now, 0)),
  },
  {
    regex: new RegExp(String.raw`${PREP}\b(?:end\s+of\s+(?:the\s+)?month|eom)\b`, "gi"),
    resolve: (_m, now) => new Date(now.getFullYear(), now.getMonth() + 1, 0),
  },
];

/**
 * Find the best date expression in `text`, resolved against `now`.
 * Returns null when no rule matches. When rules overlap, the match that
 * starts earliest wins; ties go to the longer match.
 */
export function extractDate(text: string, now: Date): DateMatch | null {
  let best: DateMatch | null = null;
  for (const rule of RULES) {
    rule.regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.regex.exec(text)) !== null) {
      const candidate: DateMatch = {
        date: toDayString(rule.resolve(m, now)),
        start: m.index,
        end: m.index + m[0].length,
        text: m[0],
      };
      if (
        best === null ||
        candidate.start < best.start ||
        (candidate.start === best.start && candidate.end > best.end)
      ) {
        best = candidate;
      }
    }
  }
  return best;
}

/** Remove the matched span from the text and tidy up leftover whitespace/punctuation. */
export function stripMatch(text: string, match: DateMatch): string {
  return (text.slice(0, match.start) + " " + text.slice(match.end))
    .replace(/\s+/g, " ")
    .replace(/\s+([,.!?;:])/g, "$1")
    .replace(/[\s,;:]+$/g, "")
    .trim();
}
