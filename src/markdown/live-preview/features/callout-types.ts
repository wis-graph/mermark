// Callout type SSOT. Obsidian's 13 canonical callout types, their aliases, their
// default display label, and their Lucide icon — one table, looked up once. No
// inline `if (type === 'warning')` anywhere: every consumer (line class, head
// widget, colour) derives from `resolveCalloutType`. The function is a pure query
// (raw string in → resolved type out, no side effects, CQS-clean).

import { type IconName } from "../../../icons";

export interface CalloutType {
  /** Canonical key. Drives the `cm-callout-{key}` CSS class and colour token. */
  key: string;
  /** Title-cased display name, shown when the head has no explicit title. */
  label: string;
  /** Lucide icon name (icons.ts PATHS key) rendered before the title. */
  icon: IconName;
}

/** Canonical types, keyed by `key`. Obsidian's official set (help/callouts). */
const CALLOUT_TYPES: Record<string, CalloutType> = {
  note: { key: "note", label: "Note", icon: "square-pen" },
  abstract: { key: "abstract", label: "Abstract", icon: "clipboard-list" },
  info: { key: "info", label: "Info", icon: "info" },
  todo: { key: "todo", label: "Todo", icon: "circle-check" },
  tip: { key: "tip", label: "Tip", icon: "flame" },
  success: { key: "success", label: "Success", icon: "check" },
  question: { key: "question", label: "Question", icon: "circle-help" },
  warning: { key: "warning", label: "Warning", icon: "triangle-alert" },
  failure: { key: "failure", label: "Failure", icon: "x" },
  danger: { key: "danger", label: "Danger", icon: "zap" },
  bug: { key: "bug", label: "Bug", icon: "bug" },
  example: { key: "example", label: "Example", icon: "list" },
  quote: { key: "quote", label: "Quote", icon: "quote" },
};

/** Alias → canonical key. Obsidian's documented synonyms. */
const ALIASES: Record<string, string> = {
  summary: "abstract",
  tldr: "abstract",
  hint: "tip",
  important: "tip",
  check: "success",
  done: "success",
  help: "question",
  faq: "question",
  caution: "warning",
  attention: "warning",
  fail: "failure",
  missing: "failure",
  error: "danger",
  cite: "quote",
};

/** Title-case a raw type string for the fallback label (`frobnicate` → `Frobnicate`). */
function titleCase(raw: string): string {
  return raw.length === 0 ? raw : raw[0].toUpperCase() + raw.slice(1).toLowerCase();
}

/** Resolve a raw callout type (case-insensitive, alias-aware) to its canonical
 *  `{key, label, icon}`. Unsupported types fall back to `note` styling/icon while
 *  keeping the raw spelling (title-cased) as the label, so a typo still shows what
 *  the author wrote. Pure: depends only on `raw`. */
export function resolveCalloutType(raw: string): CalloutType {
  const lower = raw.toLowerCase();
  const canonical = ALIASES[lower] ?? lower;
  const known = CALLOUT_TYPES[canonical];
  if (known) return known;
  // Unsupported → note colour/icon, but the label echoes what the author typed.
  return { key: "note", label: titleCase(raw), icon: CALLOUT_TYPES.note.icon };
}

/** A `> [!type] title` head, with the `[!` markup and optional `±` fold sign
 *  stripped. `type` is raw (not yet resolved); `title` is trimmed (may be empty,
 *  in which case the caller substitutes the resolved type's label). */
export interface CalloutHead {
  type: string;
  title: string;
}

// Groups: [1]=type, [2]=fold sign (+/-/none, absorbed but not acted on — mermark
// has no fold UI yet), [3]=title text. Leading `>` marks (possibly nested) eaten.
const CALLOUT_HEAD = /^\s*(?:>\s*)+\[!(\w+)\]([+-]?)\s*(.*)$/;

/** Parse a head line into `{type, title}`, or `null` when it is not a callout
 *  head (a plain blockquote line). Pure query over the line text. */
export function parseCalloutHead(lineText: string): CalloutHead | null {
  const m = CALLOUT_HEAD.exec(lineText);
  if (!m) return null;
  return { type: m[1], title: m[3].trim() };
}
