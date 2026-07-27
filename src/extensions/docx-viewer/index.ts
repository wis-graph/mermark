// The docx (Word) viewer — the fourth real viewer extension after Excel/
// HTML/PDF, living entirely behind the `../../api` facade (api-fence
// enforces this — tests/api-fence.test.ts). Registers through the same
// `registerViewer` every other viewer uses, so opening a non-markdown file
// has exactly one dispatch path regardless of built-in vs. extension
// (main.ts's viewerForEntry/openWithViewer — unchanged).
//
// BACKEND: zero new Tauri commands (01_architect_design.md 핵심 판정 1) —
// `readLocalFileBytes` (../../api) already fetches a local file's raw bytes
// through the existing asset-protocol path, exactly like pdf-viewer/
// excel-viewer/html-viewer.
//
// COLD LOAD (CLAUDE.md's constraint, same rule pdf-viewer's `pdfjs-dist` and
// excel-viewer's `xlsx` follow): `docx-preview` is dynamic-imported ONLY
// inside open()'s handler — never at module load / registerDocxViewer()
// time — so activateExtensions() (main.ts boot) never pulls it into the
// initial bundle. scripts/viewer-golden.mjs's docx scenario measures this via
// performance.getEntriesByType("resource").
//
// RENDER STRATEGY: docx-preview's `renderAsync(data, bodyContainer,
// styleContainer, options)` injects DOM DIRECTLY (unlike pdf.js, where this
// codebase draws to a canvas) — including its own `<style>` elements. Both
// containers are pane-LOCAL divs (never document.head), so `shell.close()`'s
// `pane.remove()` is the ENTIRE cleanup — no separate style-removal code is
// needed, and no `shell.onTeardown` registration for it either (design §핵심
// 판정 2(a)/(c)).
import {
  registerViewer,
  openViewerShell,
  readLocalFileBytes,
  type Viewer,
  type ViewerHandle,
} from "../../api";
import { docxContainerKind, type DocxContainerKind } from "./container-kind";

const STYLE_ID = "ext-docx-viewer-style";

/** Inject this extension's own `<style>` once (idempotent) — extensions
 *  can't touch styles.css (api-fence spirit; pdf/excel/html viewer
 *  precedent). CSP `style-src 'self' 'unsafe-inline'` (tauri.conf.json)
 *  already permits an inline element. Command (void). */
function ensureStyleInjected(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  // NO size envelope here (full-pane rewrite, design §C: "콘텐츠 루트는 이제
  // 아무 width/height도 선언하지 않는다 — 셸 flex가 소유"). `.docx-viewer` is
  // openViewerShell's paneClass — it lands on the SAME element as
  // `.viewer-panel` (shell.ts's `pane.className = "<paneClass> viewer-panel"`),
  // so `.viewer-panel`'s own flex box (styles.css) already supplies this
  // element's definite size — tests/viewer-size-envelope.test.ts's
  // content-root gate asserts this file's injected CSS declares no
  // width/height/max-* on `.docx-viewer`.
  style.textContent = `
.docx-viewer-pages {
  flex: 1; min-height: 0; overflow: auto;
  display: block; padding: 0;
}
.docx-viewer-status { padding: 12px; color: var(--muted); font-size: 1em; }
/* docx-preview's own generated markup — className "docx" (the library's
 * default className option, kept as-is: design §핵심 판정 2(a), unlikely to
 * collide since mermark itself owns no .docx* class). White paper even in
 * dark mode (html-viewer's ".html-viewer-frame { background: #fff }"
 * precedent — a document viewer's whole promise is showing the ORIGINAL
 * document, not a theme-inverted one). 재호출 3차 (팀리드 지시, html 뷰어와
 * 정렬): no shadow, no page frame — this is a FLAT surface filling the panel,
 * not a floating sheet of paper, matching how .html-viewer-frame fills its
 * pane edge-to-edge. */
.docx-viewer-pages .docx-wrapper {
  background: transparent; padding: 0;
}
/* docx-preview writes width/padding/min-height as an INLINE style on every
 * generated section (from the document's sectPr) — measured directly in the
 * real app (aside MCP, dev server, sample.docx): the observed inline style
 * was exactly "padding: 70.85pt; width: 595.3pt; min-height: 841.9pt;". An
 * inline style beats any stylesheet rule without !important, so these are
 * the ONLY three properties overridden here — nothing else about
 * docx-preview's own markup is touched. width:100% fills the panel (no more
 * "photo in a frame" sub-panel box); the 94px/2.5cm Word page margin becomes
 * a modest reading padding instead (html-viewer parity, not a literal page
 * margin); min-height:0 lets multiple sections stack as one continuous
 * document rather than each claiming a fixed A4 height. box-sizing:border-box
 * so the padding doesn't push the element past width:100%. */
.docx-viewer-pages .docx-wrapper > section.docx {
  background: #fff;
  box-shadow: none;
  margin-bottom: 0;
  width: 100% !important;
  min-height: 0 !important;
  padding: 40px 48px !important;
  box-sizing: border-box;
}
`;
  document.head.appendChild(style);
}

/** A minimal shape of the docx-preview module surface this file actually
 *  calls — kept local rather than depending on docx-preview's own types at
 *  the call site below (mirrors pdf-viewer.ts's `PdfjsModule` pattern). */
interface DocxPreviewModule {
  renderAsync(
    data: ArrayBuffer | Blob | Uint8Array,
    bodyContainer: HTMLElement,
    styleContainer: HTMLElement | null,
    options?: Record<string, unknown>,
  ): Promise<unknown>;
}

/** The user-facing message for a docx open failure — the single named rule
 *  (plan Stage 4 "인라인 if로 open()에 심지 말 것") that turns a
 *  `DocxContainerKind` + optional render error into the exact wording table
 *  in 01_architect_design.md §핵심 판정 3. Pure query. */
export function docxOpenErrorMessage(kind: DocxContainerKind, err?: unknown): string {
  if (kind === "cfb") {
    return "문서를 열 수 없습니다: 구형 .doc 형식이거나 암호로 보호된 문서입니다";
  }
  if (kind === "unknown") {
    return "문서를 열 수 없습니다: .docx 형식이 아닙니다";
  }
  // kind === "zip": a genuine OOXML container that either rendered fine (no
  // error reaches this function in that case) or failed inside renderAsync
  // (corrupted/non-OOXML zip) — surface renderAsync's own message, same
  // "문서를 열 수 없습니다: ${err.message}" format pdf/excel/html use. `err`
  // is only ever omitted by a caller mistake (every real call site passes
  // the caught renderAsync error) — falling back to a generic phrase here
  // instead of `String(undefined)` keeps that mistake from ever surfacing a
  // literal "undefined" to the user.
  if (err === undefined) return "문서를 열 수 없습니다: 알 수 없는 오류";
  return `문서를 열 수 없습니다: ${err instanceof Error ? err.message : String(err)}`;
}

/** Open `absPath` in the docx viewer: shell up immediately with a loading
 *  status, then fetch bytes + dynamic-import docx-preview in the background,
 *  gate on `docxContainerKind`, and swap in the rendered pages (or an error
 *  status) when ready. Mirrors excel-viewer's openExcelViewer shape. Command. */
function openDocxViewer(absPath: string): ViewerHandle {
  ensureStyleInjected();
  const content = document.createElement("div");
  content.className = "docx-viewer-status";
  content.textContent = "문서 불러오는 중…";

  const shell = openViewerShell({ absPath, paneClass: "docx-viewer", content });

  // Set the instant `shell.close()` runs, even mid-flight — the async IIFE
  // below checks this before ever touching `content` again (design §핵심
  // 판정 2(c): a load that finishes AFTER the user already Esc'd out must
  // never resurrect the pane's content or flash a stale status).
  let closed = false;
  shell.onTeardown(() => {
    closed = true;
  });

  (async () => {
    const [bytes, docxPreview] = await Promise.all([
      readLocalFileBytes(absPath),
      import("docx-preview") as unknown as Promise<DocxPreviewModule>,
    ]);

    const kind = docxContainerKind(bytes);
    if (kind !== "zip") {
      throw new Error(docxOpenErrorMessage(kind));
    }

    // styleHost/bodyHost are BOTH children of `content` ITSELF — content
    // becomes the scroll container directly (className "docx-viewer-pages"),
    // the SAME two-layer contract every other document viewer here uses
    // (pdf-viewer.ts: `content.className = "pdf-viewer-pages"`, hwp-viewer
    // identical — 04_audit_report.md blocker: a THIRD unstyled wrapper div
    // between the shell's `.viewer-panel-body` (flex:1; overflow:hidden) and
    // `.docx-viewer-pages` (flex:1; overflow:auto) leaves that middle div's
    // own `flex:1` inert — with no CSS of its own it never grows to fill
    // `.viewer-panel-body`, and `.viewer-panel-body`'s `overflow:hidden`
    // then clips whatever the pages column renders past that shrunk box,
    // with no scrollbar to reach the rest). renderAsync injects the
    // document's generated `<style>` into styleHost and the rendered
    // `.docx-wrapper` markup into bodyHost; neither ever touches
    // document.head, so pane.remove() (shell.close()) is still the entire
    // cleanup for both — this fix removes the extra wrapper LAYER, not the
    // pane-local-styleHost isolation itself.
    const styleHost = document.createElement("div");
    const bodyHost = document.createElement("div");

    try {
      await docxPreview.renderAsync(bytes, bodyHost, styleHost, {
        className: "docx",
        inWrapper: true,
      });
    } catch (renderErr) {
      // A zip that isn't actually a valid OOXML package (corrupted / not a
      // Word document at all) — renderAsync's own message is the useful part
      // here, wrapped in the same "문서를 열 수 없습니다:" prefix as every
      // other viewer's catch.
      throw new Error(docxOpenErrorMessage("zip", renderErr));
    }

    // Skip the swap if the shell already closed while renderAsync was still
    // in flight (design §핵심 판정 2(c)) — writing into `content` after
    // close() is harmless (a detached node), but swapping its className
    // here would leave a dangling ".docx-viewer-pages" status a moment
    // before this same tick's close() teardown runs, a needless flash of
    // the wrong state. Mirrors excel/pdf's own "still open" gate.
    if (closed) return;
    content.className = "docx-viewer-pages";
    content.replaceChildren(styleHost, bodyHost);
  })().catch((err: unknown) => {
    if (closed) return;
    content.replaceChildren();
    content.className = "docx-viewer-status";
    content.textContent = err instanceof Error ? err.message : String(err);
  });

  // Viewer-local zoom (design §핵심 판정 4): CSS `zoom`, not a transform —
  // docx pages are DOM/vector text (no re-raster needed like PDF's canvas),
  // and `zoom` (unlike `transform: scale`) participates in layout, so the
  // scroll area matches what's actually shown at any zoom level (a
  // transform-scaled seq of stacked pages would either leave dead scroll
  // space when shrunk or clip when enlarged). Applied to `content` itself —
  // the SAME element as the scroll container above, so the zoomed box and
  // the scrolling box are never two different elements that could drift out
  // of sync. 재호출 3차: the fit-to-width composition (`userZoom * fit`) is
  // GONE along with the page frame it served — there is no "page" to fit to
  // a fraction of the panel anymore (width:100% fills it directly), so this
  // is back to the plain single-factor sink pdf/hwp use before the 2차
  // detour.
  shell.onTeardown(
    shell.zoom.bind((factor) => {
      content.style.zoom = String(factor);
    }),
  );

  // onClose forwards the shell teardown so the OPENER learns about closes it
  // did not initiate (Esc / header ✕) — see ViewerHandle.onClose.
  return { close: () => shell.close(), onClose: (cb) => shell.onTeardown(cb) };
}

const DOCX_VIEWER: Viewer = {
  id: "ext.docx", // NEVER-RENAME (registry.ts) — disabledViewersSetting persists this id
  extensions: ["docx"], // .doc is NOT claimed — docx-preview cannot read a CFB container
  label: "Word (docx)",
  open: openDocxViewer,
};

/** Register the docx viewer. Called once from activateExtensions() at boot
 *  (main.ts, before the first document mounts) — registerViewer's own
 *  duplicate-id guard makes a second call a developer error, matching every
 *  other registry in this codebase. Command (void). */
export function registerDocxViewer(): void {
  registerViewer(DOCX_VIEWER);
}
