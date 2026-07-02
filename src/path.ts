/** Parent directory of a path, or "" when the path has no directory part.
 *  Handles posix (/) and windows (\) separators. */
export function dirOf(path: string): string {
  const sep = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return sep >= 0 ? path.slice(0, sep) : "";
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

/** Shorten an absolute root path into a compact header label: abbreviate the home
 *  prefix to `~`, then, when the path has more than `keepSegments` segments, keep
 *  only the last N behind a leading `…/` (the current folder + its parents carry
 *  the most information). Pure — the caller keeps the full path in title/aria for
 *  accessibility. Short paths pass through unchanged. */
export function formatRootLabel(path: string, keepSegments = 3): string {
  const abbreviated = abbreviateHome(path);
  const sep = abbreviated.includes("\\") && !abbreviated.includes("/") ? "\\" : "/";
  const segments = abbreviated.split(sep).filter((s) => s.length > 0);
  if (segments.length <= keepSegments) return abbreviated;
  return `…/${segments.slice(-keepSegments).join("/")}`;
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
