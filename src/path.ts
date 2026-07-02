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
