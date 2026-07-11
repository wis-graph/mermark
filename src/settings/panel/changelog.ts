// Pure parsing for CHANGELOG.md's "Keep a Changelog" shape — no DOM here so the
// grouping logic is unit-testable without mounting the version pane. Shared by
// two callers: the 버전 category's "변경 내역" section (the whole file, newest N
// sections) and the update-available card's release notes (a single
// `update.body` string, which shares the same "### Category / - bullet" body
// shape without the outer "## [version] - date" heading).

/** One "### Category" block: its label (already mapped to Korean, or the raw
 *  heading text if unrecognized) + its "- " bullet lines in document order. */
export interface ChangelogGroup {
  category: string;
  items: string[];
}

/** One "## [version] - date" block: the version/date parsed from the heading
 *  (date is null when the heading omits it) + its category groups. */
export interface ChangelogSection {
  version: string;
  date: string | null;
  groups: ChangelogGroup[];
}

const VERSION_HEADING = /^##\s+\[([^\]]+)\](?:\s*-\s*(.+))?/;

// Keep a Changelog's standard category vocabulary → the Korean labels the
// panel shows. Anything outside this set (a typo, a future category) falls
// back to the raw heading text rather than being dropped.
const CATEGORY_LABELS: Record<string, string> = {
  Added: "추가",
  Changed: "변경",
  Fixed: "수정",
  Removed: "제거",
  Deprecated: "지원 중단",
  Security: "보안",
};

function categoryLabel(raw: string): string {
  return CATEGORY_LABELS[raw] ?? raw;
}

/** `### Added` → `"Added"`; anything else → null. Named so the line-dispatch
 *  loop below reads as a series of named checks, not inline regex noise. */
function categoryHeadingText(line: string): string | null {
  const m = /^###\s+(.+)$/.exec(line);
  return m ? m[1].trim() : null;
}

/** `- some text` → `"some text"`; anything else → null. */
function bulletText(line: string): string | null {
  const m = /^-\s+(.+)$/.exec(line);
  return m ? m[1].trim() : null;
}

/** Parse a changelog entry's body (everything under a `## [version]` heading,
 *  OR a bare `update.body` release-notes string that shares the same shape) into
 *  its category groups, in document order. A `---` rule line and blank lines are
 *  noise and skipped; a non-heading/non-bullet line is treated as a wrapped
 *  continuation of the previous bullet. Pure query — no DOM, no side effects. */
export function parseChangelogGroups(body: string): ChangelogGroup[] {
  const groups: ChangelogGroup[] = [];
  let current: ChangelogGroup | null = null;

  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line === "---") continue;

    const cat = categoryHeadingText(line);
    if (cat != null) {
      current = { category: categoryLabel(cat), items: [] };
      groups.push(current);
      continue;
    }

    const bullet = bulletText(line);
    if (bullet != null) {
      if (current == null) {
        current = { category: "", items: [] }; // bullets with no preceding ### — keep them, unlabeled
        groups.push(current);
      }
      current.items.push(bullet);
      continue;
    }

    // A stray version heading (## ...) or plain text before any bullet has
    // nothing to attach to — ignore it rather than guessing.
    if (current && current.items.length > 0) {
      current.items[current.items.length - 1] += ` ${line}`; // wrapped bullet continuation
    }
  }

  return groups;
}

/** Parse CHANGELOG.md's full content into its newest `limit` version sections
 *  (document order is newest-first, so this is just "the first `limit`
 *  `## [version]` headings"). Pure query. */
export function parseChangelogSections(raw: string, limit: number): ChangelogSection[] {
  const lines = raw.split("\n");
  const headingLines: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (VERSION_HEADING.test(lines[i].trim())) headingLines.push(i);
  }

  const sections: ChangelogSection[] = [];
  for (let s = 0; s < headingLines.length && sections.length < limit; s++) {
    const m = VERSION_HEADING.exec(lines[headingLines[s]].trim());
    if (!m) continue; // unreachable (same test as above), keeps TS narrowing happy
    const bodyStart = headingLines[s] + 1;
    const bodyEnd = s + 1 < headingLines.length ? headingLines[s + 1] : lines.length;
    sections.push({
      version: m[1].trim(),
      date: m[2]?.trim() ?? null,
      groups: parseChangelogGroups(lines.slice(bodyStart, bodyEnd).join("\n")),
    });
  }
  return sections;
}
