// The HTML viewer (R11 2단계, _workspace/01_html_viewer.md) — the second real
// viewer extension after Excel, living entirely behind the `../../api` facade
// (api-fence enforces this — tests/api-fence.test.ts). Registers through the
// same `registerViewer` the built-in image and Excel viewers use, so opening
// a non-markdown file has exactly one dispatch path regardless of built-in
// vs. extension (main.ts's viewerForEntry/openWithViewer — unchanged).
//
// THE CONTRACT THIS VIEWER MAKES (design §3.1 — read this before touching
// the sandbox line below): "static rendering only". A user's .html file is
// rendered as text/images/inline-styled markup; it is NEVER given a way to
// run script, in ANY execution context, under ANY circumstance. This is not
// a temporary limitation to relax later — allow-scripts was explicitly
// evaluated and REJECTED (design §3.1/§3.2): the app's own CSP
// (`script-src 'self'`) already kills inline/external scripts even if
// allow-scripts were granted (verified with a native WKWebView harness, not
// assumed), so the ONLY thing granting allow-scripts would buy is a bigger
// attack surface for zero real interactivity gained. If a future change ever
// adds an `allow-scripts`/`allow-same-origin` token to the iframe below,
// that is a SECURITY REGRESSION, not a feature — tests/html-viewer.test.ts's
// T1 exists specifically to turn red the moment that happens.
//
// THREAT MODEL SUMMARY (design §2 — full table there): sandbox="" blocks
// script execution outright (①); no allow-same-origin means even a script
// that somehow ran couldn't reach `parent.__TAURI_INTERNALS__` (②, opaque
// origin); the inherited CSP `script-src 'self'` is a THIRD independent wall
// (③) if ① and ② were both somehow bypassed. `iframe.srcdoc = html` is a
// PROPERTY assignment (never an attribute string built by concatenation) so
// there is no attribute-escaping surface to get wrong. DOMPurify is
// deliberately NOT used (design §3.5) — sandbox already blocks execution at
// the engine level, and a sanitizer's own parser-differential bugs would add
// risk, not reduce it, on top of that.
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  registerViewer,
  openViewerShell,
  readLocalFileBytes,
  fontScale,
  type Viewer,
  type ViewerHandle,
} from "../../api";
import { decodeHtmlBytes, rewriteRelativeSrcAttrs } from "./prepare-html";

const STYLE_ID = "ext-html-viewer-style";

/** Inject this extension's own `<style>` once (idempotent) — extensions
 *  can't touch styles.css (api-fence spirit; Excel viewer precedent). CSP
 *  `style-src 'self' 'unsafe-inline'` (tauri.conf.json, UNCHANGED by this
 *  design — §0) already permits an inline `<style>` element. Command
 *  (void). */
function ensureStyleInjected(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
.html-viewer { width: min(92vw, 1100px); max-height: min(88vh, 760px); }
/* The LOADED state's content wrapper — becomes the iframe's flex/scroll
 * boundary (mirrors excel-viewer-body's role: the outer .viewer-panel-body
 * (styles.css, shell-owned) gives every viewer's content a bounded flex
 * context to grow inside; this is the viewer's OWN flex-1/min-height:0
 * child inside that boundary, same two-layer contract Excel established). */
.html-viewer-frame-wrap { flex: 1; min-height: 0; overflow: hidden; display: flex; }
.html-viewer-frame { display: block; width: 100%; height: 100%; border: 0; background: #fff; }
.html-viewer-status { padding: 12px; color: var(--muted); font-size: 1em; }
`;
  document.head.appendChild(style);
}

/** Parent directory of an absolute path — a LOCAL copy of
 *  `document/path.ts`'s `dirOf`, not an import of it: `src/extensions/**`
 *  may only import "../../api" (facade), a sibling file inside this
 *  extension's own tree, or a bare npm package (tests/api-fence.test.ts) —
 *  `document/path.ts` is none of those, and the facade deliberately does not
 *  re-export path helpers (an extension has no other legitimate reason to
 *  need one today, design §4's "소형 조건부" note). Pure query — same
 *  separator rule as the original (posix `/` and windows `\`, whichever
 *  appears last). */
function parentDir(path: string): string {
  const sep = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return sep >= 0 ? path.slice(0, sep) : "";
}

/** Apply the parent-side zoom transform (design §6 — iframe documents can't
 *  inherit `--font-scale`, so `.html-viewer-frame`'s own box is scaled from
 *  the OUTSIDE instead of injecting any font-size into `srcdoc`). Sizing the
 *  iframe UP by `1/scale` before scaling it DOWN by `scale` keeps its
 *  post-transform footprint exactly filling `.html-viewer-frame-wrap`, at
 *  any zoom level, without a reflow/reload of the document inside (scroll
 *  position survives). Command (void) — a DOM mutation, not a query. */
function applyHtmlZoom(iframe: HTMLIFrameElement, scale: number): void {
  iframe.style.width = `calc(100% / ${scale})`;
  iframe.style.height = `calc(100% / ${scale})`;
  iframe.style.transform = `scale(${scale})`;
  iframe.style.transformOrigin = "0 0";
}

/** Open `absPath` in the HTML viewer: shell up immediately with a loading
 *  status, then fetch bytes + decode + rewrite relative asset src's in the
 *  background and swap in the sandboxed iframe (or an error status) when
 *  ready. Mirrors excel-viewer's openExcelViewer shape (design §7 step 4).
 *  Command. */
function openHtmlViewer(absPath: string): ViewerHandle {
  ensureStyleInjected();
  const content = document.createElement("div");
  content.className = "html-viewer-status";
  content.textContent = "문서 불러오는 중…";

  const shell = openViewerShell({ absPath, modalClass: "html-viewer", content });

  const iframe = document.createElement("iframe");
  iframe.className = "html-viewer-frame";
  // THE SECURITY-CRITICAL LINE (design §0/§2/§7 T1): setAttribute with an
  // EXPLICIT empty string, not the `sandbox` boolean attribute idiom
  // (`iframe.sandbox = ...`) — jsdom's DOMTokenList PutForwards support for
  // `sandbox` is inconsistent across versions, and this form makes the
  // intent (an EXACTLY-empty token list — full containment, no exceptions)
  // impossible to get subtly wrong via a stray token. NEVER add a token
  // here — see this file's header comment.
  iframe.setAttribute("sandbox", "");
  // No `src` — this viewer never URL-loads a document into the frame (that
  // would put it under `frame-src`, this app's narrowest CSP directive,
  // design §2's "external self-navigate" row). `srcdoc` is assigned as a
  // DOM PROPERTY below, after the content is ready — never built as an HTML
  // attribute string, so there is no attribute-escaping surface at all.

  // Zoom sink (design §6): observe the fontScale SSOT through the facade's
  // READ-ONLY view (`../../api`'s `fontScale` — get/subscribe/bind, no `set`,
  // enforced at runtime not just in the types). An extension cannot overwrite
  // the user's zoom level even if it wanted to; the single writer stays the
  // app's own zoomIn/zoomOut/resetZoom commands. `.bind` applies the CURRENT
  // scale immediately (so a viewer opened after the user already zoomed
  // starts correctly scaled) and again on every future change; its
  // unsubscribe is registered with the shell's teardown so it stops firing
  // after close().
  const unsubscribeZoom = fontScale.bind((scale) => applyHtmlZoom(iframe, scale));
  shell.onTeardown(unsubscribeZoom);

  (async () => {
    const bytes = await readLocalFileBytes(absPath);
    const decoded = decodeHtmlBytes(bytes);
    const prepared = rewriteRelativeSrcAttrs(decoded, parentDir(absPath), convertFileSrc);

    content.className = "html-viewer-frame-wrap";
    content.replaceChildren(iframe);
    // PROPERTY assignment, not `iframe.setAttribute("srcdoc", prepared)` —
    // `srcdoc` as a DOM property never round-trips through the parent
    // document's HTML parser/attribute-string escaping at all (design §2's
    // "srcdoc 문자열이 부모 문서 파싱에 새는 것" row); this is the second
    // security-critical line in this file, alongside the sandbox attribute
    // above.
    iframe.srcdoc = prepared;
  })().catch((err) => {
    content.replaceChildren();
    content.className = "html-viewer-status";
    content.textContent = `문서를 열 수 없습니다: ${err instanceof Error ? err.message : String(err)}`;
  });

  return { close: () => shell.close() };
}

const HTML_VIEWER: Viewer = {
  id: "ext.html",
  extensions: ["html", "htm"],
  open: openHtmlViewer,
};

/** Register the HTML viewer. Called once from activateExtensions() at boot
 *  (main.ts, before the first document mounts) — registerViewer's own
 *  duplicate-id guard makes a second call a developer error, matching every
 *  other registry in this codebase. Command (void). */
export function registerHtmlViewer(): void {
  registerViewer(HTML_VIEWER);
}
