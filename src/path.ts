/** Parent directory of a path, or "" when the path has no directory part.
 *  Handles posix (/) and windows (\) separators. */
export function dirOf(path: string): string {
  const sep = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return sep >= 0 ? path.slice(0, sep) : "";
}
