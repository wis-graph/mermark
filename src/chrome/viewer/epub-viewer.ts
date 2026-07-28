// The EPUB viewer — a BUILT-IN viewer (_workspace/01_architect_design_epub.md
// §0/R11 계약), not an extension: it needs 2 new Tauri commands
// (arm_epub_view/read_epub_entry) plus a custom `epub://` scheme handler, and
// R11's extension contract is "frontend only, zero new IPC" (design §0). It
// registers through the SAME `registerViewer` every other viewer uses, so
// opening a non-markdown file has exactly one dispatch path regardless of
// built-in vs. extension (main.ts's viewerForEntry/openWithViewer).
//
// THE SECURITY CONTRACT THIS VIEWER MAKES (design §2/§4): a book's raw HTML
// NEVER enters the app DOM. The app only ever parses METADATA XML
// (container.xml/OPF/nav/NCX/encryption.xml, all via `read_epub_entry` and
// `epub-parse.ts`'s `DOMParser`-only functions) — chapter HTML is loaded
// DIRECTLY by an iframe via `iframe.src = epub://<token>/<entry>`, never
// fetched into this process, never assigned via `innerHTML`/`srcdoc`. If a
// future change ever pipes a chapter's bytes through `read_epub_entry` and
// injects them into `.epub-viewer-chapter` via `innerHTML`, that is a
// SECURITY REGRESSION (this file's header promise broken) — the same class
// of contract hwp-viewer.ts's img-only rule and docx-viewer's XML-only
// parsing enforce for their own formats.
//
// SANDBOX (design §4): every chapter iframe gets EXACTLY
// `sandbox="allow-scripts allow-same-origin"` — same two tokens, same
// reasoning as html-viewer's scripted path (allow-same-origin is required
// for sibling CSS/image/font loads under WebKit's custom-scheme
// `canDisplay` gate; the frame's origin is `epub://<token>`, cross-origin
// from the app `tauri://localhost`, so SOP still blocks `parent.document`/
// IPC). Book SCRIPTS are killed one layer down, by the backend's per-token
// CSP (`script-src` naming only `measure.js`) — this file does not, and
// cannot, enforce that; it only trusts the scheme handler to have set it.
//
// DEPENDENCY DIRECTION (design §5): this file (chrome/) NEVER imports
// `sidebar/outline/outline-panel` — `registerEpubViewer(deps)` takes a
// `setTocOverride` closure instead, injected by main.ts at boot. The toc
// item shape below is a STRUCTURAL twin of `OutlineOverrideItem`
// (sidebar/outline/outline-panel.ts), not an import of it.
import { invoke } from "@tauri-apps/api/core";
import { registerViewer, type Viewer, type ViewerHandle } from "./registry";
import { openViewerShell } from "./shell";
import { isNearViewport } from "./hwp-pages";
import {
  epubRootfilePath,
  parseOpf,
  parseNavToc,
  parseNcxToc,
  hasContentEncryption,
  epubOpenErrorMessage,
  chapterIndexForMessage,
  entryDir,
  type EpubTocEntry,
  type EpubTocSource,
  type EpubFrameEntry,
} from "./epub-parse";

const EPUB_SCHEME = "epub";

/** The origin every chapter iframe of ONE open book shares — `epub://<token>`,
 *  minted fresh per `arm_epub_view` call (design §1's per-open-token
 *  isolation, same posture as htmlview's per-open origin). Pure query. */
function epubOrigin(token: string): string {
  return `${EPUB_SCHEME}://${token}`;
}

/** The `iframe.src` URL for one spine chapter — `entry`'s path segments are
 *  percent-encoded individually (never the whole path, which would also
 *  encode the `/` separators the backend's scheme handler needs to see
 *  literally). Pure query. */
export function epubViewUrl(token: string, entry: string): string {
  const encoded = entry
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  return `${epubOrigin(token)}/${encoded}`;
}

/** A non-markdown viewer's own toc item, injected into the outline panel via
 *  `setTocOverride` — structurally identical to
 *  `sidebar/outline/outline-panel.ts`'s `OutlineOverrideItem`, deliberately
 *  NOT imported from there (see this file's header comment). */
export interface EpubTocOverrideItem {
  readonly level: number;
  readonly text: string;
  jump(): void;
}

export interface EpubViewerDeps {
  /** Replace the outline panel's md-heading source with this book's toc, or
   *  restore it with `null` — called once on successful toc parse and again
   *  (with `null`) on every close, including Esc/✕ (design §5: "뷰어 open 시
   *  TOC 파싱 완료 → setOverride(entries); shell.onTeardown(() =>
   *  setOverride(null))"). */
  setTocOverride(items: readonly EpubTocOverrideItem[] | null): void;
}

interface EpubChapter {
  readonly index: number;
  /** Zip-entry path (spine order). */
  readonly entry: string;
  readonly placeholder: HTMLElement;
  /** `null` until this chapter is lazily loaded (`loadChapter`). */
  iframe: HTMLIFrameElement | null;
  /** `id` → `offsetTop` map from the chapter's own measure.js message —
   *  empty until the frame's first postMessage arrives. Used for fragment
   *  jumps (design §7). */
  anchors: Record<string, number>;
}

/** One chapter's placeholder — `min-height: 60vh` (styles.css) is its ONLY
 *  size promise before it loads; once `loadChapter` runs and the first
 *  measure message arrives, an explicit `height` (below) takes over. Pure
 *  query. */
function chapterPlaceholder(index: number): HTMLElement {
  const el = document.createElement("div");
  el.className = "epub-viewer-chapter";
  el.dataset.chapterIndex = String(index);
  return el;
}

/** Apply the SAME parent-side zoom transform html-viewer's `applyHtmlZoom`
 *  uses (design §7): the iframe's own CSS width is scaled to `100%/scale`
 *  and then visually scaled back by `transform: scale(scale)` — net apparent
 *  width unchanged, but the frame's OWN internal viewport narrows/widens,
 *  so its content reflows and `measure.js`'s ResizeObserver posts a NEW
 *  height reflecting that. That new height is what the message handler
 *  (below) turns into this chapter's reserved layout space — there is no
 *  separate "recompute height on zoom" path; the frame does it for us.
 *  Command (void). */
function applyEpubZoom(iframe: HTMLIFrameElement, scale: number): void {
  iframe.style.width = `calc(100% / ${scale})`;
  iframe.style.transform = `scale(${scale})`;
  iframe.style.transformOrigin = "0 0";
}

/** Lazily set `chapter`'s iframe `src` (idempotent — a chapter already
 *  loaded is left untouched, so a repeat IntersectionObserver fire or a toc
 *  jump landing on an already-visible chapter never re-navigates the
 *  frame). Command (void). */
function loadChapter(chapter: EpubChapter, token: string, zoomFactor: number): void {
  if (chapter.iframe) return;
  const iframe = document.createElement("iframe");
  iframe.className = "epub-viewer-chapter-frame";
  // THE SECURITY-CRITICAL LINE (this file's header comment / design §4):
  // exactly these two tokens. Book scripts are killed by the backend's
  // per-token CSP, not by sandbox — allow-same-origin is required for
  // sibling CSS/image/font loads to succeed at all under WebKit's
  // custom-scheme canDisplay gate (htmlview precedent).
  iframe.setAttribute("sandbox", "allow-scripts allow-same-origin");
  applyEpubZoom(iframe, zoomFactor);
  iframe.src = epubViewUrl(token, chapter.entry);
  chapter.placeholder.replaceChildren(iframe);
  chapter.iframe = iframe;
}

/** Wire up lazy chapter rendering: a real `IntersectionObserver` when the
 *  runtime has one, or an eager "load every chapter immediately" fallback
 *  when it doesn't (jsdom has no IntersectionObserver — same fallback shape
 *  hwp-viewer.ts's `observePages` uses; `isNearViewport` is the ONE piece of
 *  code this file shares with it, per design §3's "코드 공유는 hwp-pages의
 *  isNearViewport만"). Command (returns a disconnect handle). */
function observeChapters(
  root: HTMLElement,
  chapters: readonly EpubChapter[],
  onVisible: (chapter: EpubChapter) => void,
): { disconnect(): void } {
  if (typeof IntersectionObserver === "function") {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!isNearViewport(entry)) continue;
          const idx = Number((entry.target as HTMLElement).dataset.chapterIndex ?? "-1");
          const chapter = chapters[idx];
          if (chapter) onVisible(chapter);
        }
      },
      { root, rootMargin: "200% 0px" },
    );
    for (const c of chapters) observer.observe(c.placeholder);
    return observer;
  }
  for (const c of chapters) onVisible(c);
  return { disconnect() {} };
}

/** Translate `arm_epub_view`'s wire-level rejection into a user-facing
 *  message (backend contract, `_workspace/02_backend_changes_epub.md`): a
 *  non-zip file rejects with the EXACT literal `"not-zip"` — mapped through
 *  `epubOpenErrorMessage` for the Korean-facing wording. Every other
 *  rejection (a canonicalize/IO failure) is already a human-readable
 *  `"arm {path}: {e}"` string from the backend and is shown as-is. Pure
 *  query. */
function armErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw === "not-zip" ? epubOpenErrorMessage("not-zip") : raw;
}

/** Read `META-INF/encryption.xml` and decide whether this book is DRM-gated
 *  (design §2/§6): an entry-not-found rejection from `read_epub_entry` means
 *  "no encryption.xml" — treated as no-DRM, NOT an open failure (most books
 *  have no such file at all). Throws `epubOpenErrorMessage("drm")` only when
 *  the file EXISTS and `hasContentEncryption` says so. Command (throws on
 *  DRM, otherwise resolves void). */
async function assertNotDrm(token: string): Promise<void> {
  let encryptionXml: string;
  try {
    encryptionXml = await invoke<string>("read_epub_entry", { token, entry: "META-INF/encryption.xml" });
  } catch {
    return; // no encryption.xml (or unreadable) — not a DRM signal
  }
  if (hasContentEncryption(encryptionXml)) throw new Error(epubOpenErrorMessage("drm"));
}

/** Parse this book's table of contents (EPUB3 nav or EPUB2 NCX, per
 *  `pkg.tocSource` — the single dispatch `epubTocSource`, epub-parse.ts,
 *  already decided). A missing or unreadable toc source degrades to `[]`
 *  (no toc shown) — never an open failure (design §6: a toc is a nicety,
 *  not a requirement to read the book). Pure-ish (one invoke, no DOM
 *  writes). */
async function readTocEntries(token: string, tocSource: EpubTocSource | null): Promise<EpubTocEntry[]> {
  if (!tocSource) return [];
  try {
    const tocXml = await invoke<string>("read_epub_entry", { token, entry: tocSource.href });
    const dir = entryDir(tocSource.href);
    return tocSource.kind === "nav" ? parseNavToc(tocXml, dir) : parseNcxToc(tocXml, dir);
  } catch {
    return [];
  }
}

/** The postMessage payload measure.js sends (design §3) — only the fields
 *  this file reads. */
interface EpubSizeMessage {
  readonly type: "mermark-epub-size";
  readonly height: number;
  readonly anchors?: Record<string, number>;
}

function isEpubSizeMessage(data: unknown): data is EpubSizeMessage {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { type?: unknown }).type === "mermark-epub-size" &&
    typeof (data as { height?: unknown }).height === "number"
  );
}

/** Open `absPath` in the EPUB viewer: shell up immediately with a loading
 *  status, then arm → parse container/OPF → DRM gate → toc → chapter
 *  placeholders → lazy observe, all in the background. Mirrors hwp-viewer's
 *  openHwpViewer shape (plan Stage F3). Command. */
function openEpubViewer(absPath: string, deps: EpubViewerDeps): ViewerHandle {
  const content = document.createElement("div");
  content.className = "epub-viewer-status";
  content.textContent = "책을 불러오는 중…";

  const shell = openViewerShell({ absPath, paneClass: "epub-viewer", content });

  // Set the instant close() runs, even mid-flight — the async work below
  // checks this before ever touching `content`/dispatching a late toc again
  // (docx-viewer's `closed` guard, same reasoning: a load that finishes
  // AFTER the user already Esc'd out must never resurrect the pane).
  let closed = false;
  let messageHandler: ((e: MessageEvent) => void) | null = null;
  let observerHandle: { disconnect(): void } | null = null;
  shell.onTeardown(() => {
    closed = true;
    if (messageHandler) window.removeEventListener("message", messageHandler);
    observerHandle?.disconnect();
    // Idempotent even when no toc was ever set — restores the md-heading
    // path on every close, Esc/✕ included (design §5).
    deps.setTocOverride(null);
  });

  // Shell-owned viewer-local zoom (design §7), cached the same way hwp-
  // viewer.ts caches it — chapters loaded AFTER a zoom change read this
  // CURRENT value via closure, never a stale snapshot.
  let zoomFactor = shell.zoom.get();
  let chapters: EpubChapter[] = [];
  const unsubscribeZoom = shell.zoom.bind((factor) => {
    zoomFactor = factor;
    for (const c of chapters) if (c.iframe) applyEpubZoom(c.iframe, factor);
  });
  shell.onTeardown(unsubscribeZoom);

  (async () => {
    let token: string;
    try {
      token = await invoke<string>("arm_epub_view", { path: absPath });
    } catch (err) {
      throw new Error(armErrorMessage(err));
    }

    // A missing/unreadable container.xml is just as "no META-INF/
    // container.xml" as a container.xml that parses but carries no
    // <rootfile> — epubOpenErrorMessage("no-rootfile")'s wording already
    // covers both ("손상된 EPUB입니다 (container.xml 없음)"), so both
    // failure shapes fold into the SAME message here.
    let containerXml: string;
    try {
      containerXml = await invoke<string>("read_epub_entry", { token, entry: "META-INF/container.xml" });
    } catch {
      throw new Error(epubOpenErrorMessage("no-rootfile"));
    }
    const rootfilePath = epubRootfilePath(containerXml);
    if (!rootfilePath) throw new Error(epubOpenErrorMessage("no-rootfile"));

    let opfXml: string;
    try {
      opfXml = await invoke<string>("read_epub_entry", { token, entry: rootfilePath });
    } catch {
      throw new Error(epubOpenErrorMessage("corrupt"));
    }
    const pkg = parseOpf(opfXml, entryDir(rootfilePath));

    await assertNotDrm(token);
    if (closed) return;

    const tocEntries = await readTocEntries(token, pkg.tocSource);
    if (closed) return;

    chapters = pkg.spine.map((entry, index) => ({
      index,
      entry,
      placeholder: chapterPlaceholder(index),
      iframe: null,
      anchors: {},
    }));

    content.className = "epub-viewer-chapters";
    content.replaceChildren(...chapters.map((c) => c.placeholder));

    /** Jump to `entryPath`/`fragment` (a toc entry's target): force-load the
     *  chapter if it hasn't been lazily rendered yet, then scroll the
     *  chapters column to its placeholder top plus whatever anchor offset
     *  this chapter's OWN measure.js reported for `fragment` (0 if unknown —
     *  design §7's "정밀 점프의 완전 보장은 v1 비목표"). Command (void). */
    const jumpToEntry = (entryPath: string, fragment: string | null): void => {
      const chapter = chapters.find((c) => c.entry === entryPath);
      if (!chapter) return;
      if (!chapter.iframe) loadChapter(chapter, token, zoomFactor);
      const anchorOffset = fragment ? (chapter.anchors[fragment] ?? 0) : 0;
      content.scrollTo({ top: chapter.placeholder.offsetTop + anchorOffset, behavior: "auto" });
    };

    if (tocEntries.length > 0) {
      deps.setTocOverride(
        tocEntries.map((entry) => ({
          level: entry.level,
          text: entry.text,
          jump: () => jumpToEntry(entry.entry, entry.fragment),
        })),
      );
    }

    // Height sync: measure.js is the ONLY code that runs inside a chapter
    // frame (design §3) — it posts {type, height, anchors} on every
    // ResizeObserver tick. Double-checked before trusting it: origin must be
    // THIS book's `epub://<token>` (never a stale/foreign token) AND source
    // must be a window we ourselves put in an iframe (chapterIndexForMessage,
    // epub-parse.ts — origin+source, never origin alone).
    const origin = epubOrigin(token);
    messageHandler = (event: MessageEvent) => {
      if (!isEpubSizeMessage(event.data)) return;
      const frames: EpubFrameEntry[] = chapters.map((c) => ({ origin, contentWindow: c.iframe?.contentWindow ?? null }));
      const idx = chapterIndexForMessage({ origin: event.origin, source: event.source }, frames);
      if (idx === null) return;
      const chapter = chapters[idx];
      const { height, anchors } = event.data;
      if (chapter.iframe) chapter.iframe.style.height = `${height}px`;
      // The reserved SCROLL-FLOW space is height × the CURRENT zoom factor —
      // the iframe's own box stays at its unscaled height (`height`px above)
      // and `applyEpubZoom`'s CSS transform visually magnifies it; the
      // placeholder must reserve that MAGNIFIED footprint so chapters never
      // overlap/gap at non-1x zoom.
      chapter.placeholder.style.height = `${height * zoomFactor}px`;
      if (anchors) chapter.anchors = anchors;
    };
    window.addEventListener("message", messageHandler);

    observerHandle = observeChapters(content, chapters, (chapter) => loadChapter(chapter, token, zoomFactor));
  })().catch((err: unknown) => {
    if (closed) return;
    content.replaceChildren();
    content.className = "epub-viewer-status";
    content.textContent = err instanceof Error ? err.message : String(err);
  });

  // onClose forwards the shell teardown so the OPENER learns about closes it
  // did not initiate (Esc / header ✕) — see ViewerHandle.onClose.
  return { close: () => shell.close(), onClose: (cb) => shell.onTeardown(cb) };
}

const EPUB_VIEWER_EXTENSIONS = ["epub"] as const;

/** Register the EPUB viewer. Called once from main.ts's boot registration
 *  block — `registerViewer`'s own duplicate-id guard makes a second call a
 *  developer error, matching every other registry in this codebase. `deps`
 *  is the ONE closure this file needs from main.ts (design §5's
 *  dependency-direction rule). Command (void). */
export function registerEpubViewer(deps: EpubViewerDeps): void {
  const viewer: Viewer = {
    id: "epub",
    extensions: [...EPUB_VIEWER_EXTENSIONS],
    label: "EPUB",
    open: (absPath) => openEpubViewer(absPath, deps),
  };
  registerViewer(viewer);
}
