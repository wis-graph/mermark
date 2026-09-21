/** Parent directory of a path, or "" when the path has no directory part.
 *  Handles posix (/) and windows (\) separators. */
export function dirOf(path: string): string {
  const sep = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return sep >= 0 ? path.slice(0, sep) : "";
}

/** The file name at the end of a path (posix or windows separators) — the
 *  sibling of `dirOf`: both share the same `Math.max(lastIndexOf("/"),
 *  lastIndexOf("\\"))` separator rule, so they can never disagree on where a
 *  path splits into directory vs filename. */
export function basename(path: string): string {
  const sep = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return sep >= 0 ? path.slice(sep + 1) : path;
}

/** Is `path` equal to `ancestor`, or nested somewhere underneath it? Handles
 *  both posix (`/`) and windows (`\`) separators (a bare `startsWith(ancestor)`
 *  would wrongly match a *sibling* whose name extends `ancestor`'s — e.g.
 *  `/a/bc` must NOT be "within" `/a/b`). `ancestor === ""` is the empty-root
 *  case (`REMOTE_VAULT_WIRE_ROOT`, `workspace/workspace-state.ts`) — a
 *  remote vault's wire-relative paths carry no leading separator to append
 *  a trailing `/`/`\` to, so `path.startsWith("/")` would always be false
 *  and wrongly report every remote sub-folder note as NOT within the vault
 *  root; every path is within the vault root by definition, so this
 *  short-circuits to `true` there. Promoted from `workspace/cli-routing.ts`'s
 *  private `isWithinRoot` (same boundary check, now shared with the
 *  explorer panel's `showsFolderOf`) — the two callers must never drift on
 *  what "within" means. Pure query (CQS). */
export function isPathWithin(path: string, ancestor: string): boolean {
  if (path === ancestor || ancestor === "") return true;
  return path.startsWith(`${ancestor}/`) || path.startsWith(`${ancestor}\\`);
}

// Windows path-prefix regexes, longest/most-specific first — a `\\?\` verbatim
// form must be recognized before the plain UNC/drive forms it would otherwise
// be misparsed as (see `windowsPathPrefix`'s doc comment).
const VERBATIM_DRIVE_PREFIX = /^\\\\\?\\[A-Za-z]:/;
const VERBATIM_UNC_PREFIX = /^\\\\\?\\UNC\\[^\\/]+\\[^\\/]+/;
const UNC_PREFIX = /^\\\\[^\\/?.]+[\\/][^\\/]+/;
const DRIVE_PREFIX = /^[A-Za-z]:/;

/** The Windows path prefix `path` starts with — a verbatim drive (`\\?\C:`), a
 *  verbatim UNC (`\\?\UNC\srv\share`), a plain UNC (`\\srv\share`), or a plain
 *  drive (`C:`) — or `""` when `path` carries none of these (a posix path, a
 *  relative path, or an incomplete/unrecognized verbatim form like `\\?\` or
 *  `\\?\Volume{…}`, which this deliberately leaves unmatched rather than
 *  guessing at a shape it doesn't understand). The plain-UNC regex excludes
 *  `?` from its server segment, so it can never match a verbatim path; the
 *  most-specific-first ordering here is about readability, not about avoiding
 *  a false positive. Shared by
 *  `normalizePath` (to preserve the prefix across `..`/`.` traversal — see
 *  `windowsPathPrefixIsDrive` for why a drive prefix and a UNC prefix rejoin
 *  differently) and `isFilesystemRoot` (to recognize a bare drive/UNC root).
 *  Pure query (CQS). */
export function windowsPathPrefix(path: string): string {
  return (
    VERBATIM_DRIVE_PREFIX.exec(path)?.[0] ??
    VERBATIM_UNC_PREFIX.exec(path)?.[0] ??
    UNC_PREFIX.exec(path)?.[0] ??
    DRIVE_PREFIX.exec(path)?.[0] ??
    ""
  );
}

/** Is `prefix` a DRIVE-shaped Windows prefix (`C:`, `\\?\C:` — ends in the
 *  drive letter's colon, no directory of its own) rather than a UNC-shaped one
 *  (`\\srv\share`, `\\?\UNC\srv\share` — the server+share IS already a
 *  complete root, nothing to append a bare separator to)? `normalizePath`
 *  uses this to decide whether an EMPTY body still needs a trailing separator
 *  appended to name the root (`C:` + `..` → `C:\`) or not (`\\srv\share` +
 *  `..` → `\\srv\share`, never `\\srv\share\` — appending one there would be
 *  a value this function would have to un-normalize on the next pass). Named
 *  so this asymmetry reads as an intentional rule, not an inline branch. */
function windowsPathPrefixIsDrive(prefix: string): boolean {
  return prefix.endsWith(":");
}

/** Which separator a path "speaks": `\` for any path carrying a recognized
 *  Windows prefix (verbatim paths reject `/` outright, so once a prefix is
 *  present the whole path must stay backslash-only — see
 *  `01_architect_design.md` §(a)); otherwise `\` only when the path has a
 *  backslash and no forward slash, `/` otherwise (posix default). Shared by
 *  `normalizePath` (to rejoin segments) and `formatRootLabel` (to split them)
 *  so the two never disagree on which character is the separator for a given
 *  path. */
function detectSeparator(path: string): "\\" | "/" {
  if (windowsPathPrefix(path)) return "\\";
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

  const prefix = windowsPathPrefix(path);
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

  if (prefix) {
    if (body) return `${prefix}${sep}${body}`;
    // Empty body: a drive prefix still needs `sep` appended to name its root
    // (`C:` + `..` → `C:\`); a UNC prefix already IS the root as-is (see
    // `windowsPathPrefixIsDrive`'s doc comment — never `\\srv\share\`).
    return windowsPathPrefixIsDrive(prefix) && isRooted ? `${prefix}${sep}` : prefix;
  }
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

/** Whether a RESOLVED path (e.g. `canonicalize_path`'s return value) is
 *  actually usable as a filesystem root: posix root (`/…`), a Windows drive
 *  (`C:\…` / `C:/…`), or a Windows UNC path (`\\server\share`). Deliberately
 *  narrower than `isAbsoluteLike` above (which also accepts a literal `~`
 *  because THAT function checks USER-TYPED input the backend still has to
 *  expand). A value that has already come back from the backend and still
 *  starts with `~` means home-directory resolution failed there (see
 *  `expand_home`'s documented literal-fallback contract in
 *  `src-tauri/src/commands.rs`) — it is a relative path, not a usable root,
 *  and callers like `resolveHomeRoot` must not treat it as one. */
export function isResolvedAbsolutePath(path: string): boolean {
  return (
    path.startsWith("/") ||
    path.startsWith("\\\\") ||
    /^[A-Za-z]:[\\/]/.test(path)
  );
}

/** Is `path` the ROOT of its filesystem — posix `/`, a Windows drive root
 *  (`C:`, `C:\`, `C:/`), or a Windows UNC share root (`\\srv\share`,
 *  `\\srv\share\`) — the point above which `..` has nowhere further to climb
 *  except into a DIFFERENT drive/volume? That's exactly the case the
 *  explorer's "내 컴퓨터" (My Computer) drive listing exists for
 *  (`explorer-panel.ts`'s `upTarget`): normal `..` navigation stays within
 *  one drive/share, but this is the one point where "go up" has to mean
 *  "switch drives" instead. `normalizePath`s first (so `C:/`/`\\srv\share\`
 *  match the same way their canonical forms do), then checks the REMAINDER
 *  after `windowsPathPrefix` is empty or a single trailing separator — `""`
 *  covers the UNC/no-prefix-posix-`/` case, `sep` covers a drive prefix's
 *  root (`C:\`). A non-root path (`/Users`, `C:\Users`, `\\srv\share\docs`)
 *  or a path with no filesystem root at all (`""`, `~`, a relative path) is
 *  `false`. Pure query (CQS). */
export function isFilesystemRoot(path: string): boolean {
  const normalized = normalizePath(path);
  if (normalized === "/") return true;
  const prefix = windowsPathPrefix(normalized);
  if (!prefix) return false;
  const rest = normalized.slice(prefix.length);
  return rest === "" || rest === "\\" || rest === "/";
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
