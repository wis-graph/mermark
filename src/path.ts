/** Parent directory of a path, or "" when the path has no directory part.
 *  Handles posix (/) and windows (\) separators. */
export function dirOf(path: string): string {
  const sep = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return sep >= 0 ? path.slice(0, sep) : "";
}

/** Which separator a path "speaks": `\` only when the path has a backslash and
 *  no forward slash, `/` otherwise (posix default). Shared by `normalizePath`
 *  (to rejoin segments) and `formatRootLabel` (to split them) so the two never
 *  disagree on which character is the separator for a given path. */
function detectSeparator(path: string): "\\" | "/" {
  return path.includes("\\") && !path.includes("/") ? "\\" : "/";
}

/** Collapse `.`/`..`/duplicate separators purely textually — the FRONTEND twin
 *  of the backend's `normalize_path` (src-tauri/src/commands.rs). MUST produce
 *  identical results: the backend normalizes what `list_dir` LISTS, this
 *  normalizes what the explorer DISPLAYS/STORES, and the two must never drift
 *  (tree ↔ header consistency).
 *
 *  Rules (mirrors `PathBuf` `Component` traversal): `..` pops the last kept
 *  segment; popping past the root/prefix/start of a relative path is a no-op
 *  (`/..` → `/`, leading `../a` → `a`) — `..` never climbs above the root.
 *  `.` is dropped. Consecutive/trailing separators collapse away. A leading
 *  `/` (posix root) and a Windows drive prefix (`C:`) are preserved and can
 *  never be popped below. `~` is a literal segment (no expansion) — same as
 *  the backend, which only expands `~` in `expand_home` before calling this.
 *
 *  Pure query (CQS): no IO, no DOM, no state. */
export function normalizePath(path: string): string {
  if (path === "") return path;
  const sep = detectSeparator(path);

  const driveMatch = /^[A-Za-z]:/.exec(path);
  const prefix = driveMatch ? driveMatch[0] : "";
  const rest = path.slice(prefix.length);
  const isRooted = rest.length > 0 && (rest[0] === "/" || rest[0] === "\\");

  const segments: string[] = [];
  for (const seg of rest.split(/[\\/]/)) {
    if (seg.length === 0 || seg === ".") continue;
    if (seg === "..") {
      if (segments.length > 0) segments.pop(); // no-op below root/prefix/start
      continue;
    }
    segments.push(seg);
  }
  const body = segments.join(sep);

  if (prefix) return isRooted || body ? `${prefix}${sep}${body}` : prefix;
  if (isRooted) return body ? `${sep}${body}` : sep;
  return body;
}

/** Replace a leading home directory (`/Users/<u>`, `/home/<u>`, `C:\Users\<u>`)
 *  with `~`. A pure regex heuristic — the frontend has no way to ask the backend
 *  for the real $HOME (that would need a new command), so a wrong guess simply
 *  leaves the path untouched (display-only, always safe). Named so the "shorten
 *  home" rule lives in one place. */
function abbreviateHome(path: string): string {
  return path
    .replace(/^\/Users\/[^/]+/, "~")
    .replace(/^\/home\/[^/]+/, "~")
    .replace(/^[A-Za-z]:[\\/]Users[\\/][^\\/]+/, "~");
}

/** Shorten a CANONICAL (already `normalizePath`-d — the caller, `renderTree`,
 *  guarantees this) root path into a compact header label: abbreviate the home
 *  prefix to `~`, then, when the path has more than `keepSegments` segments,
 *  keep only the last N (the current folder + its parents carry the most
 *  information) — the last segment (current folder) is therefore ALWAYS shown,
 *  never summarized away. Home-rooted long paths keep a `~/…/` prefix (so the
 *  home context survives truncation, not just implied by `…`); non-home long
 *  paths use a bare `…/`. Pure — does NOT call `normalizePath` itself (this
 *  function's name promises formatting, not path-shape normalization; that
 *  responsibility lives solely at the `renderTree` entry point). The caller
 *  keeps the full path in title/aria for accessibility. Short paths pass
 *  through unchanged. */
export function formatRootLabel(path: string, keepSegments = 3): string {
  const abbreviated = abbreviateHome(path);
  const sep = detectSeparator(abbreviated);
  const segments = abbreviated.split(sep).filter((s) => s.length > 0);
  if (segments.length <= keepSegments) return abbreviated;
  const tail = segments.slice(-keepSegments).join(sep);
  const ellipsisPrefix = abbreviated.startsWith("~") ? `~${sep}…${sep}` : `…${sep}`;
  return `${ellipsisPrefix}${tail}`;
}

/** Split `rest` on `sep`, pushing one `{label, abs}` segment per non-empty
 *  chunk and accumulating each chunk onto `rootAbs` to build that ancestor's
 *  real absolute path. Shared by every `breadcrumbSegments` branch (home /
 *  drive / posix-root / relative) so the "join with sep, skip empty chunks"
 *  rule lives in one place instead of being repeated per branch. Command
 *  (void) — mutates `segments` in place, mirroring `ctx.push` style callers. */
function appendAncestors(
  segments: { label: string; abs: string }[],
  rootAbs: string,
  rest: string,
  sep: string,
): void {
  let abs = rootAbs;
  for (const seg of rest.split(sep)) {
    if (seg.length === 0) continue;
    abs = abs === "" || abs.endsWith(sep) ? `${abs}${seg}` : `${abs}${sep}${seg}`;
    segments.push({ label: seg, abs });
  }
}

/** A normalized absolute path → its breadcrumb ancestors, each `{label, abs}`:
 *  `label` is the compact display text, `abs` is that ancestor's REAL
 *  (un-abbreviated) absolute path — the click-to-jump target. A home prefix
 *  (`/Users/<u>`, `/home/<u>`, `C:\Users\<u>`) collapses to a single `~`
 *  node whose `abs` is the real home path (label ≠ abs is the whole point:
 *  the display is short, the jump target is exact). Non-home paths get a
 *  leading root node instead (posix `/`, or the Windows drive `C:\`), so a
 *  breadcrumb for an absolute path is never empty. `~` is a literal segment
 *  the backend expands at jump time (matches `normalizePath`'s `~` rule) — it
 *  stays a single `{~, ~}` node, no expansion here. `""` → `[]` (nothing to
 *  show). Pure query (CQS): no IO, no DOM, no state — reuses `normalizePath`/
 *  `abbreviateHome`/`detectSeparator` so this can never disagree with them on
 *  what a path's segments or separator are. */
export function breadcrumbSegments(path: string): { label: string; abs: string }[] {
  path = normalizePath(path);
  if (path === "") return [];
  if (path === "~") return [{ label: "~", abs: "~" }];

  const sep = detectSeparator(path);
  const abbreviated = abbreviateHome(path);
  const segments: { label: string; abs: string }[] = [];

  if (abbreviated !== path && abbreviated.startsWith("~")) {
    // abbreviateHome replaced the leading `abbreviated.length - 1` chars of
    // `path` (everything but the "~" itself) — invert that to recover the
    // real home directory this path lives under.
    const homeReal = path.slice(0, path.length - (abbreviated.length - 1));
    segments.push({ label: "~", abs: homeReal });
    appendAncestors(segments, homeReal, path.slice(homeReal.length), sep);
    return segments;
  }

  const driveMatch = /^[A-Za-z]:/.exec(path);
  if (driveMatch) {
    const root = `${driveMatch[0]}${sep}`;
    segments.push({ label: driveMatch[0], abs: root });
    appendAncestors(segments, root, path.slice(root.length), sep);
    return segments;
  }

  if (path.startsWith(sep)) {
    segments.push({ label: sep, abs: sep });
    appendAncestors(segments, sep, path.slice(1), sep);
    return segments;
  }

  // Relative path (no root/home/drive prefix) — outside the documented
  // mapping table (breadcrumb only ever receives explorer/document roots,
  // which are absolute), handled defensively so the function stays total:
  // no leading root node, ancestors accumulate from "".
  appendAncestors(segments, "", path, sep);
  return segments;
}

/** A path the user typed that carries no target — empty or whitespace-only.
 *  Named so the "refuse to open" rule lives in one place, not an inline `if`. */
export function isBlankPath(input: string): boolean {
  return input.trim().length === 0;
}

/** An absolute path needs no baseDir join: posix root (`/…`), a Windows drive
 *  (`C:\…` / `C:/…`), or a home-relative path (`~…`) which the backend expands.
 *  Named rule so resolveOpenPath reads as intent, not a regex soup. */
function isAbsoluteLike(input: string): boolean {
  return (
    input.startsWith("/") ||
    input.startsWith("~") ||
    /^[A-Za-z]:[\\/]/.test(input)
  );
}

/** Resolve a user-typed open-path against the current document's directory.
 *  Pure (no IO): blank → null (refuse); absolute/`~` → unchanged (the backend
 *  expands `~` and normalizes `.`/`..` inside read_file, so we only JOIN here);
 *  relative → `${baseDir}/${input}` with `.`/`..` left for the backend. */
export function resolveOpenPath(input: string, baseDir: string): string | null {
  const trimmed = input.trim();
  if (isBlankPath(trimmed)) return null;
  if (isAbsoluteLike(trimmed)) return trimmed;
  return baseDir ? `${baseDir}/${trimmed}` : trimmed;
}
