/** The canonical file-extension format shared by every registry keyed on
 *  `extensionOf`'s output: non-empty, lowercase, no leading dot. A value that
 *  fails this can never match a real lookup, so registries reject it at
 *  registration time. Pure query. */
export function isCanonicalExtension(ext: string): boolean {
  return ext !== "" && ext === ext.toLowerCase() && !ext.startsWith(".");
}
