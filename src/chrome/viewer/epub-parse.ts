// Pure parsing/query layer for the EPUB viewer
// (_workspace/01_architect_design_epub.md §6). Every function here is a
// QUERY over an XML/HTML string or a DOMParser Document — no invoke, no
// fetch, no DOM mounting of the RESULT anywhere — so vitest exercises them
// directly with inline fixture strings, no editor mount and no Tauri mock
// involved (the same separation hwp-pages.ts and docx-viewer/container-kind.ts
// establish: pure helpers live outside the stateful invoke/observer glue,
// which is epub-viewer.ts's job). npm dependency 0: `DOMParser` only, per
// design §2's cold-load argument.
//
// NEVER throw: every function here degrades to null/[]/a safe default on
// malformed input (docx-viewer/container-kind.ts's "절대 throw 금지" standard —
// a corrupted book should surface as `epubOpenErrorMessage`, not an
// unhandled exception from three layers down).

/** Every element in `root`'s subtree whose LOCAL name is `name`, regardless
 *  of namespace — container.xml/OPF/NCX each declare their own default
 *  namespace, and `getElementsByTagName` (which matches the QUALIFIED name)
 *  would silently return nothing against a prefixed or namespaced document.
 *  The `"*"` namespace wildcard is what makes this namespace-agnostic. Pure
 *  query. */
function byLocalName(root: Document | Element, name: string): Element[] {
  return Array.from(root.getElementsByTagNameNS("*", name));
}

/** True when `doc` is a DOMParser XML parse-error document (its own
 *  `<parsererror>` element) — the standard signal a `DOMParser` gives
 *  instead of throwing. Pure query. */
function hasParserError(doc: Document): boolean {
  return doc.getElementsByTagName("parsererror").length > 0;
}

/** Parse `xml` as a namespace-aware XML document (container.xml/OPF/NCX are
 *  all strict XML by spec, unlike chapter xhtml — see `parseTagSoupHtml`
 *  below for that one's more tolerant sibling). Pure query. */
function parseStrictXml(xml: string): Document {
  return new DOMParser().parseFromString(xml, "application/xml");
}

/** Parse `html` with the HTML tag-soup parser — used ONLY for nav.xhtml
 *  (EPUB3 toc), which in the wild is not always strict XML (real books).
 *  Mirrors the backend's own tag-soup choice for chapter xhtml (design §2:
 *  "엄격 XML 파서는 살짝 깨진 책을 통째로 파싱 실패시킨다"), applied here on
 *  the frontend for the same reason. Pure query. */
function parseTagSoupHtml(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

/** The directory a zip-entry path is inside, WITH a trailing slash (or ""
 *  for a root-level entry) — the shape `resolveEntryHref`'s `baseDir` param
 *  expects. Pure query. */
export function entryDir(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx >= 0 ? path.slice(0, idx + 1) : "";
}

/** `dir` with exactly one trailing slash, or "" — the internal normal form
 *  every `resolveEntryHref` caller's `baseDir` is coerced to, so a caller
 *  that forgets the trailing slash (or passes "") never mis-joins a path.
 *  Pure query. */
function normalizeDir(dir: string): string {
  if (dir === "") return "";
  return dir.endsWith("/") ? dir : `${dir}/`;
}

/** The direct child of `el` whose tag name (case-insensitive, per HTML/XML
 *  tag-name matching) is `tag` — used instead of `:scope >` selectors so nav
 *  toc parsing doesn't depend on `:scope` support. Pure query. */
function directChild(el: Element, tag: string): Element | null {
  for (const c of Array.from(el.children)) {
    if (c.tagName.toLowerCase() === tag) return c;
  }
  return null;
}

// ---------------------------------------------------------------------------
// container.xml → OPF rootfile path
// ---------------------------------------------------------------------------

/** container.xml's `<rootfile full-path="...">` — the zip-entry path to the
 *  package (OPF) document. `null` when the XML is malformed or carries no
 *  rootfile (a corrupted/non-EPUB zip) — the caller turns that into
 *  `epubOpenErrorMessage("no-rootfile")`. Pure query. */
export function epubRootfilePath(containerXml: string): string | null {
  const doc = parseStrictXml(containerXml);
  if (hasParserError(doc)) return null;
  const path = byLocalName(doc, "rootfile")[0]?.getAttribute("full-path");
  return path && path.length > 0 ? path : null;
}

// ---------------------------------------------------------------------------
// OPF (package document): manifest, spine, toc source, rendition layout
// ---------------------------------------------------------------------------

export interface EpubManifestItem {
  readonly id: string;
  /** Zip-entry path (already resolved against the OPF's own directory). */
  readonly entry: string;
  readonly mediaType: string;
  readonly properties: readonly string[];
}

export type EpubTocSource = { readonly kind: "nav"; readonly href: string } | { readonly kind: "ncx"; readonly href: string };

export type EpubRenditionLayout = "reflowable" | "pre-paginated";

export interface EpubPackage {
  /** Spine reading order, as zip-entry paths (manifest hrefs already
   *  resolved) — ready to hand straight to the viewer's per-chapter iframe
   *  `src` builder. */
  readonly spine: readonly string[];
  readonly manifest: readonly EpubManifestItem[];
  /** `null` when the book has neither an EPUB3 nav item nor an EPUB2
   *  `spine[toc]` — the viewer then simply shows no table of contents
   *  (never an error; a missing toc is not a reason to refuse the book). */
  readonly tocSource: EpubTocSource | null;
  readonly layout: EpubRenditionLayout;
  /** The book's `dc:identifier` (trimmed, non-empty), or `null` when absent
   *  — the reading-position feature's preferred SSOT key
   *  (`epub-position.ts`'s `epubPositionKey`, design_epub_position.md §2:
   *  survives a file move/rename, shared across copies of the same book).
   *  `epubIdentifier` below is the single place this extraction rule
   *  lives. */
  readonly identifier: string | null;
}

/** The OPF's `dc:identifier` to use as this book's stable key (design
 *  §2): the `dc:identifier` element whose `id` matches
 *  `<package unique-identifier="...">` wins (the spec-sanctioned "this ONE
 *  is canonical" pointer); if that doesn't resolve (attribute absent, or no
 *  identifier carries that id), the FIRST `dc:identifier` in document order
 *  is the fallback; blank/absent altogether → `null` (the caller then falls
 *  back to the absolute path, `epubPositionKey`). Pure query. */
function epubIdentifier(opfDoc: Document): string | null {
  const identifiers = byLocalName(opfDoc, "identifier");
  const uniqueId = byLocalName(opfDoc, "package")[0]?.getAttribute("unique-identifier");
  const preferred = uniqueId ? identifiers.find((el) => el.getAttribute("id") === uniqueId) : undefined;
  const text = (preferred ?? identifiers[0])?.textContent?.trim();
  return text ? text : null;
}

/** THE single function that decides EPUB3 nav vs. EPUB2 NCX — the design's
 *  §6 mandate that this judgment live in exactly one place. Rule: a manifest
 *  item whose `properties` token list contains `"nav"` wins, EVEN when an
 *  NCX also exists (EPUB3 books commonly ship both, for EPUB2 reader
 *  fallback) — nav is the more complete/authoritative source in that case.
 *  Only when no nav item exists does `<spine toc="...">` (the classic EPUB2
 *  pointer to an NCX manifest item) get consulted. `null` when neither is
 *  present. Hrefs returned here are RAW (still relative to the OPF's own
 *  directory) — `parseOpf` below is what resolves them into zip-entry paths;
 *  this function does one job only: pick the source. Pure query. */
export function epubTocSource(opfDoc: Document): EpubTocSource | null {
  const items = byLocalName(opfDoc, "item");
  const navItem = items.find((el) => (el.getAttribute("properties") ?? "").split(/\s+/).includes("nav"));
  const navHref = navItem?.getAttribute("href");
  if (navHref) return { kind: "nav", href: navHref };

  const tocId = byLocalName(opfDoc, "spine")[0]?.getAttribute("toc");
  if (tocId) {
    const ncxHref = items.find((el) => el.getAttribute("id") === tocId)?.getAttribute("href");
    if (ncxHref) return { kind: "ncx", href: ncxHref };
  }
  return null;
}

/** `<meta property="rendition:layout">` — `"pre-paginated"` when declared,
 *  `"reflowable"` (the default per the EPUB3 rendition spec) otherwise.
 *  Judgment-only in v1 (design §6: "거절하지 않고 최선 노력 렌더" — this value
 *  is read but never branches on to reject a book). Pure query. */
export function epubRenditionLayout(opfDoc: Document): EpubRenditionLayout {
  const layout = byLocalName(opfDoc, "meta")
    .find((el) => el.getAttribute("property") === "rendition:layout")
    ?.textContent?.trim();
  return layout === "pre-paginated" ? "pre-paginated" : "reflowable";
}

/** Parse the OPF (package) document: manifest items (hrefs resolved to
 *  zip-entry paths against `opfDir`), spine reading order (itemref idrefs
 *  resolved through the manifest, entries with no manifest match silently
 *  dropped — a malformed spine ref should not crash the whole book), the toc
 *  source (`epubTocSource`, href resolved the same way), and the rendition
 *  layout. Malformed XML degrades to an empty, tocless, reflowable package —
 *  never throws. Pure query. */
export function parseOpf(opfXml: string, opfDir: string): EpubPackage {
  const doc = parseStrictXml(opfXml);
  const dir = normalizeDir(opfDir);
  if (hasParserError(doc)) return { spine: [], manifest: [], tocSource: null, layout: "reflowable", identifier: null };

  const manifest: EpubManifestItem[] = byLocalName(doc, "item").map((el) => ({
    id: el.getAttribute("id") ?? "",
    entry: resolveEntryHref(dir, el.getAttribute("href") ?? "").entry,
    mediaType: el.getAttribute("media-type") ?? "",
    properties: (el.getAttribute("properties") ?? "").split(/\s+/).filter(Boolean),
  }));
  const byId = new Map(manifest.map((item) => [item.id, item] as const));

  const spine = byLocalName(doc, "itemref")
    .map((el) => byId.get(el.getAttribute("idref") ?? "")?.entry)
    .filter((entry): entry is string => Boolean(entry));

  const rawToc = epubTocSource(doc);
  const tocSource: EpubTocSource | null = rawToc
    ? { kind: rawToc.kind, href: resolveEntryHref(dir, rawToc.href).entry }
    : null;

  return { spine, manifest, tocSource, layout: epubRenditionLayout(doc), identifier: epubIdentifier(doc) };
}

// ---------------------------------------------------------------------------
// Relative href → zip-entry path + fragment
// ---------------------------------------------------------------------------

export interface EpubResolvedHref {
  readonly entry: string;
  readonly fragment: string | null;
}

/** Resolve a relative `href` (as found in an OPF manifest, a nav/NCX toc
 *  entry, or a chapter's own `<link>/<img>`) against `baseDir` into a
 *  zip-entry path + an optional `#fragment`, normalizing `.`/`..` segments.
 *  An `href` starting with `/` is treated as already-absolute-within-the-zip
 *  (leading slash stripped, `baseDir` ignored) — rare in practice but a
 *  well-formed possibility. Percent-encoded hrefs (spaces, non-ASCII
 *  filenames) are decoded so the result matches the zip's actual entry
 *  names. Pure query. */
export function resolveEntryHref(baseDir: string, href: string): EpubResolvedHref {
  const hashIdx = href.indexOf("#");
  const rawPath = hashIdx >= 0 ? href.slice(0, hashIdx) : href;
  const fragment = hashIdx >= 0 ? decodeURIComponent(href.slice(hashIdx + 1)) : null;
  const decodedPath = decodeURIComponent(rawPath);

  const dir = normalizeDir(baseDir);
  const combined = decodedPath.startsWith("/") ? decodedPath.slice(1) : `${dir}${decodedPath}`;

  const out: string[] = [];
  for (const part of combined.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return { entry: out.join("/"), fragment };
}

// ---------------------------------------------------------------------------
// Table of contents: EPUB3 nav.xhtml / EPUB2 NCX → one shared shape
// ---------------------------------------------------------------------------

export interface EpubTocEntry {
  /** Nesting depth, 1-based (a top-level `<li>` is level 1). */
  readonly level: number;
  readonly text: string;
  /** Zip-entry path the entry jumps to. */
  readonly entry: string;
  readonly fragment: string | null;
}

/** EPUB3 nav toc (`<nav epub:type="toc">…<ol><li><a href>…</a></li></ol>`)
 *  → the shared `EpubTocEntry[]` shape (the point where nav and NCX
 *  converge, design §6). `epub:type` is read as a plain attribute (not
 *  namespace-resolved) since this is parsed with the HTML tag-soup parser
 *  (`parseTagSoupHtml`), which does not track XML namespaces — the EPUB3
 *  spec's `epub:` prefix is conventionally literal anyway. Entries with no
 *  `href` or empty text (a toc heading with no anchor) are skipped, not
 *  pushed as broken links. Pure query. */
export function parseNavToc(navXhtml: string, navDir: string): EpubTocEntry[] {
  const doc = parseTagSoupHtml(navXhtml);
  const navEl = Array.from(doc.getElementsByTagName("nav")).find((el) =>
    (el.getAttribute("epub:type") ?? "").split(/\s+/).includes("toc"),
  );
  const topOl = navEl ? directChild(navEl, "ol") : null;
  if (!topOl) return [];

  const dir = normalizeDir(navDir);
  const out: EpubTocEntry[] = [];
  const walk = (ol: Element, level: number): void => {
    for (const li of Array.from(ol.children)) {
      if (li.tagName.toLowerCase() !== "li") continue;
      const a = directChild(li, "a") ?? directChild(li, "span");
      const href = a?.getAttribute("href");
      const text = (a?.textContent ?? "").trim();
      if (href && text) {
        const { entry, fragment } = resolveEntryHref(dir, href);
        out.push({ level, text, entry, fragment });
      }
      const nestedOl = directChild(li, "ol");
      if (nestedOl) walk(nestedOl, level + 1);
    }
  };
  walk(topOl, 1);
  return out;
}

/** EPUB2 NCX toc (`<navMap><navPoint><navLabel><text>…</text></navLabel>
 *  <content src="…"/><navPoint>…nested…</navPoint></navPoint></navMap>`) →
 *  the SAME `EpubTocEntry[]` shape `parseNavToc` produces (design §6: "두
 *  소스가 같은 타입으로 수렴하는 지점"). `byLocalName` on each `navPoint`
 *  picks the FIRST matching descendant, which — because the NCX schema
 *  requires `navLabel`/`content` before any nested `navPoint` — is always
 *  THIS navPoint's own label/content, never a nested one's. Pure query. */
export function parseNcxToc(ncxXml: string, ncxDir: string): EpubTocEntry[] {
  const doc = parseStrictXml(ncxXml);
  if (hasParserError(doc)) return [];
  const navMap = byLocalName(doc, "navMap")[0];
  if (!navMap) return [];

  const dir = normalizeDir(ncxDir);
  const out: EpubTocEntry[] = [];
  const walk = (parent: Element, level: number): void => {
    for (const child of Array.from(parent.children)) {
      if (child.localName !== "navPoint") continue;
      const text = byLocalName(child, "text")[0]?.textContent?.trim() ?? "";
      const src = byLocalName(child, "content")[0]?.getAttribute("src");
      if (src && text) {
        const { entry, fragment } = resolveEntryHref(dir, src);
        out.push({ level, text, entry, fragment });
      }
      walk(child, level + 1);
    }
  };
  walk(navMap, 1);
  return out;
}

// ---------------------------------------------------------------------------
// DRM detection
// ---------------------------------------------------------------------------

/** The two font-obfuscation algorithms IDPF/Adobe define — these encrypt
 *  ONLY embedded font files (a legal, common practice), never the book's
 *  actual content, so their presence in encryption.xml must NOT be treated
 *  as DRM (design §6: "존재 자체로 거절하면 폰트 난독화만 있는 합법 책을
 *  오거절한다"). */
const FONT_OBFUSCATION_ALGORITHMS = new Set([
  "http://www.idpf.org/2008/embedding",
  "http://ns.adobe.com/pdf/enc#RC",
]);

/** True when `encryptionXml` (META-INF/encryption.xml) declares content
 *  encryption BEYOND font obfuscation — the DRM gate. A book with NO
 *  encryption.xml at all never reaches this function (its absence IS
 *  "no DRM" — the caller's job, not this one's). Pure query. */
export function hasContentEncryption(encryptionXml: string): boolean {
  const doc = parseStrictXml(encryptionXml);
  if (hasParserError(doc)) return false;
  return byLocalName(doc, "EncryptionMethod").some((el) => !FONT_OBFUSCATION_ALGORITHMS.has(el.getAttribute("Algorithm") ?? ""));
}

// ---------------------------------------------------------------------------
// Open-error messages — one table, one function (docx's epubOpenErrorMessage precedent)
// ---------------------------------------------------------------------------

export type EpubOpenErrorKind = "drm" | "not-zip" | "no-rootfile" | "corrupt" | "unknown";

const EPUB_OPEN_ERROR_MESSAGES: Record<EpubOpenErrorKind, string> = {
  drm: "문서를 열 수 없습니다: DRM으로 보호된 EPUB입니다",
  "not-zip": "문서를 열 수 없습니다: EPUB 형식이 아닙니다",
  "no-rootfile": "문서를 열 수 없습니다: 손상된 EPUB입니다 (container.xml 없음)",
  corrupt: "문서를 열 수 없습니다: 손상된 EPUB 파일입니다",
  unknown: "문서를 열 수 없습니다: 알 수 없는 오류",
};

/** The single place every EPUB open-failure message is chosen — docx's
 *  `docxOpenErrorMessage` precedent (design §6), so a new failure kind is
 *  always a one-line table addition, never a scattered inline string. Pure
 *  query. */
export function epubOpenErrorMessage(kind: EpubOpenErrorKind): string {
  return EPUB_OPEN_ERROR_MESSAGES[kind];
}

// ---------------------------------------------------------------------------
// measure.js postMessage → chapter index
// ---------------------------------------------------------------------------

/** One chapter iframe's identity, as the viewer's frame list carries it —
 *  `origin` is the `epub://<token>` origin every chapter in ONE open book
 *  shares, `contentWindow` is the specific frame's window (what
 *  `event.source` is compared against). */
export interface EpubFrameEntry {
  readonly origin: string;
  readonly contentWindow: unknown;
}

/** The chapter index a `measure.js` postMessage came from, or `null` when
 *  EITHER the origin doesn't match this book's armed `epub://<token>` origin
 *  OR no known frame's `contentWindow` equals `event.source` — the double
 *  check design §3 requires so a compromised/foreign frame can never spoof
 *  another chapter's height. Pure query. */
export function chapterIndexForMessage(
  event: { readonly origin: string; readonly source: unknown },
  frames: readonly EpubFrameEntry[],
): number | null {
  const idx = frames.findIndex((f) => f.origin === event.origin && f.contentWindow === event.source);
  return idx >= 0 ? idx : null;
}
