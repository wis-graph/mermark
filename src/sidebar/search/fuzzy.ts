// Pure fuzzy-match scorer for the ⌘⇧F file-finder panel (VS Code ⌘P style —
// filename-only, no content search; see _workspace/00_request.md's explicit
// scope cut). No external dependency (fzf, etc.) — the cold-load constraint
// (CLAUDE.md) rules out a whole matcher library for what's really one
// subsequence-scoring function, and the input size (≤ MAX_SCAN_FILES) scores
// in milliseconds on the main thread (a Worker would add its own cold-load +
// WKWebView-custom-scheme risk for no measurable win — see
// _workspace/01_architect_design.md §보안·성능).
//
// CQS: every export here is a pure query (params → value, no I/O, no
// mutation) — the domain rule for "does this file match, how well" belongs
// in named constants/functions, not inline conditionals in the panel's
// render code (mermark-frontend skill §7).

/** A successful match: the candidate WAS a case-insensitive subsequence hit
 *  for the query. `fuzzyMatch` returns `null` (not this type) when it
 *  wasn't — see its own doc comment. */
export interface FuzzyMatch {
  /** Higher is a better match. Only comparable within one `fuzzyMatch` query
   *  — not a normalized [0,1] score. */
  score: number;
  /** 0-based character offsets into `relPath` that matched the query, in
   *  order — the caller highlights these (e.g. wraps each in a <mark>). */
  positions: number[];
}

// Bonuses reward WHERE a match falls; penalties punish spreading it out.
// Named constants (not inline literals) so the scoring rule reads as a
// vocabulary, and so a single tuning pass touches one place.

/** Awarded when a matched character immediately follows the PREVIOUS matched
 *  character (an unbroken run reads as a stronger signal than the same
 *  letters scattered across the string). */
const CONSECUTIVE_BONUS = 15;
/** Awarded when a matched character sits right after a path/word boundary
 *  (string start, or one of `/ - _ . ` immediately before it) — matching
 *  "nw" against "note-worthy.md" should prefer landing on both boundary
 *  letters over two characters buried mid-word. */
const BOUNDARY_BONUS = 10;
/** Awarded (on top of BOUNDARY_BONUS where it also applies) when the matched
 *  character falls within the candidate's basename — VS Code ⌘P's "filename
 *  beats containing folder" rule: typing "note" should rank `a/note.md`
 *  above `notes/a.md`. */
const BASENAME_BONUS = 8;
/** Subtracted per character SKIPPED between one matched character and the
 *  next (not per character in the candidate — only the gap counts), so a
 *  tight cluster of matches always outscores the same letters spread across
 *  a long path. */
const GAP_PENALTY = 2;
/** Subtracted once per character of the candidate's total length — a small
 *  tie-breaking nudge toward shorter (more specific) paths when two
 *  candidates otherwise score the same run of matches. Deliberately tiny
 *  relative to the bonuses above so it never outweighs match quality. */
const LENGTH_PENALTY = 0.05;

const BOUNDARY_CHARS = new Set(["/", "-", "_", ".", " "]);

/** Is the character at `i` in `s` a "fresh word" position — the string start,
 *  or immediately after a path/word-separator character? Pure query, shared
 *  by both the boundary and basename bonus checks below. */
function isBoundaryStart(s: string, i: number): boolean {
  return i === 0 || BOUNDARY_CHARS.has(s[i - 1]);
}

/** The index where the candidate's basename begins (one past its last `/`,
 *  or 0 for a bare filename with no directory component). Pure query. */
function basenameStart(relPath: string): number {
  return relPath.lastIndexOf("/") + 1;
}

/** Score `relPath` against `query` as a case-insensitive subsequence match.
 *  Returns `null` when `query` is NOT a subsequence of `relPath` (the
 *  candidate is excluded, not merely scored low) — an empty `query` never
 *  reaches this function (the panel shows the raw scan order instead; see
 *  `rankHits`), but if called with one it trivially matches with an empty
 *  `positions` array and a score of 0. Greedy left-to-right matching: each
 *  query character binds to the EARLIEST remaining candidate character that
 *  matches it — the standard fuzzy-subsequence strategy (same one VS Code's
 *  quick-open and fzf use), which keeps this O(len(relPath)) with no
 *  backtracking. Pure query (CQS). */
export function fuzzyMatch(query: string, relPath: string): FuzzyMatch | null {
  if (query.length === 0) return { score: 0, positions: [] };

  const q = query.toLowerCase();
  const s = relPath.toLowerCase();
  const baseStart = basenameStart(relPath);

  const positions: number[] = [];
  let score = 0;
  let qi = 0;
  let lastMatchIndex = -1; // for CONSECUTIVE_BONUS / GAP_PENALTY

  for (let si = 0; si < s.length && qi < q.length; si++) {
    if (s[si] !== q[qi]) continue;

    positions.push(si);
    if (lastMatchIndex === si - 1) score += CONSECUTIVE_BONUS;
    else if (lastMatchIndex >= 0) score -= (si - lastMatchIndex - 1) * GAP_PENALTY;
    if (isBoundaryStart(s, si)) score += BOUNDARY_BONUS;
    if (si >= baseStart) score += BASENAME_BONUS;

    lastMatchIndex = si;
    qi++;
  }

  if (qi < q.length) return null; // query exhausted before matching every char
  score -= relPath.length * LENGTH_PENALTY;
  return { score, positions };
}

/** How many ranked results the panel renders (v1 "quick open" scope — a
 *  fixed cap keeps the DOM small regardless of scan/candidate size; the
 *  fuzzy score already put the best matches first). */
export const MAX_RESULTS = 50;

/** One scored hit: the original candidate paired with its match (or `null`
 *  for the unscored "empty query" listing — see `rankHits`). */
export interface RankedHit<T> {
  hit: T;
  match: FuzzyMatch | null;
}

/** Rank `hits` (via `relPathOf`) against `query` and return the top `limit`.
 *  Empty query = the FIRST `limit` hits in their given (scan) order, unscored
 *  (VS Code ⌘P's "recent/all files" fallback — see
 *  _workspace/01_architect_design.md §퍼지 매칭) — no fuzzyMatch call, no
 *  positions to highlight. A non-empty query scores every hit, drops
 *  non-matches (`fuzzyMatch` returned null), and sorts by score DESCENDING,
 *  tie-broken by `relPathOf` ASCENDING (alphabetical) for deterministic
 *  output when two candidates score identically — decisive for tests and for
 *  a stable on-screen order across re-renders of the same query. Pure query
 *  (CQS): never mutates `hits`. */
export function rankHits<T>(query: string, hits: readonly T[], relPathOf: (hit: T) => string, limit: number): RankedHit<T>[] {
  if (query.length === 0) {
    return hits.slice(0, limit).map((hit) => ({ hit, match: null }));
  }
  const scored: RankedHit<T>[] = [];
  for (const hit of hits) {
    const match = fuzzyMatch(query, relPathOf(hit));
    if (match) scored.push({ hit, match });
  }
  scored.sort((a, b) => {
    const bym = b.match!.score - a.match!.score;
    if (bym !== 0) return bym;
    return relPathOf(a.hit).localeCompare(relPathOf(b.hit));
  });
  return scored.slice(0, limit);
}
