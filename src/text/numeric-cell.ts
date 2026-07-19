// The single "does this cell's display text read as a number" rule — shared
// by the markdown table widget (report-style auto right-align) and the Excel
// viewer (same alignment convention across both tables, team-lead spec
// 2026-07-20). Lives outside src/markdown and src/extensions so both sides
// can reach it without crossing into each other's tree: markdown imports it
// directly (core→core), the Excel viewer imports it through the ../../api
// facade (extensions may only reach mermark internals through that fence —
// tests/api-fence.test.ts).

const LEADING_SIGN_RE = /^[+-]/;
const LEADING_CURRENCY_RE = /^[₩$€¥￦]/;
const TRAILING_PERCENT_RE = /%$/;
const PLAIN_NUMBER_RE = /^\d+(\.\d+)?$/;
const THOUSANDS_NUMBER_RE = /^\d{1,3}(,\d{3})+(\.\d+)?$/;

/** Whether `text` (a cell's DISPLAY text, not its raw markdown/value) reads
 *  as a number — the single rule deciding right-align + tabular-nums for a
 *  table cell. Strips an optional leading sign, an optional leading currency
 *  symbol, and an optional trailing `%`, then checks the remaining core
 *  against a plain or thousands-comma number shape. Deliberately narrow: a
 *  date ("1986-01-01") or phone number ("010-1234-5678") keeps its dashes in
 *  the core and never matches, so this stays a "looks numeric" rule, not a
 *  "contains digits" rule. Pure query. */
export function looksNumeric(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === "") return false;
  const core = trimmed
    .replace(LEADING_SIGN_RE, "")
    .replace(LEADING_CURRENCY_RE, "")
    .replace(TRAILING_PERCENT_RE, "");
  return PLAIN_NUMBER_RE.test(core) || THOUSANDS_NUMBER_RE.test(core);
}
