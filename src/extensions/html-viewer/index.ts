// The HTML viewer (R11 2단계, _workspace/01_html_viewer.md) — the second real
// viewer extension after Excel, living entirely behind the `../../api` facade
// (api-fence enforces this — tests/api-fence.test.ts). Registers through the
// same `registerViewer` the built-in image and Excel viewers use, so opening
// a non-markdown file has exactly one dispatch path regardless of built-in
// vs. extension (main.ts's viewerForEntry/openWithViewer — unchanged).
//
// TWO CONTRACTS NOW, NOT ONE (_workspace/01_architect_design_htmljs.md revises
// what used to be this file's single "static rendering only" promise —
// read that design doc's §0/§2/§3/§6 before touching either open path below):
//
// OFF PATH (openStaticHtmlDocument) — the ORIGINAL contract, UNCHANGED to the
// letter: a user's .html file is rendered as text/images/inline-styled
// markup and is NEVER given a way to run script, in ANY execution context,
// under ANY circumstance, unless the user has explicitly opted in via
// `mermark.htmlViewerScripts` (settings/app.ts). This is the DEFAULT for
// every user — allow-scripts was evaluated and REJECTED for this path
// specifically (design §3.1/§3.2 of the original doc): the app's own CSP
// (`script-src 'self'`) already kills inline/external scripts even if
// allow-scripts were granted (verified with a native WKWebView harness, not
// assumed), so the ONLY thing granting allow-scripts would buy on THIS path
// is a bigger attack surface for zero real interactivity gained. If a
// future change ever adds an `allow-scripts`/`allow-same-origin` token to
// `openStaticHtmlDocument`'s iframe, that is a SECURITY REGRESSION, not a
// feature — tests/html-viewer.test.ts's T1 exists specifically to turn red
// the moment that happens. THREAT MODEL for this path (full table in the
// original design's §2): sandbox="" blocks script execution outright (①);
// no allow-same-origin means even a script that somehow ran couldn't reach
// `parent.__TAURI_INTERNALS__` (②, opaque origin); the inherited CSP
// `script-src 'self'` is a THIRD independent wall (③) if ① and ② were both
// somehow bypassed. `iframe.srcdoc = html` is a PROPERTY assignment (never
// an attribute string built by concatenation) so there is no
// attribute-escaping surface to get wrong. DOMPurify is deliberately NOT
// used (design §3.5) — sandbox already blocks execution at the engine
// level, and a sanitizer's own parser-differential bugs would add risk, not
// reduce it, on top of that.
//
// ON PATH (openScriptedHtmlDocument) — a SEPARATE, EXPLICITLY-CHOSEN threat
// model (_workspace/01_architect_design_htmljs.md §2/§3/§10, REVISION 1),
// gated behind `mermark.htmlViewerScripts` (default false). It renders
// through a DIFFERENT document entirely: the `htmlview://` custom-scheme
// handler (backend), not `srcdoc` — a local-scheme document inherits the
// embedder's CSP, which is exactly why `srcdoc` + allow-scripts could never
// work here (design §2's ⓐ/ⓑ rejections).
//
// SANDBOX (Revision 1, design §10.3): `sandbox="allow-scripts allow-same-origin"`
// — exactly these two tokens. This REVERSES the original Revision 0 rule
// ("never allow-same-origin") after a real-app measurement (design §10.1)
// found same-folder subresources (sibling `<script src>`/`<img>`/`fetch`)
// were categorically blocked under WebKit without it — WebKit treats a
// custom `WKURLSchemeHandler` scheme like a LOCAL scheme for its
// `canDisplay` check, which only lets a document display same-scheme
// resources if the document itself has a REAL origin of that scheme; an
// opaque origin (no allow-same-origin) can never satisfy that, so every
// sibling load died before CORS was even relevant (design §10.2). Why
// granting allow-same-origin is SAFE here even though it was rejected for
// the old srcdoc design: that old rule's danger was allow-same-origin +
// srcdoc's INHERITED parent origin — same-origin as the APP itself, so
// `frameElement.removeAttribute("sandbox")` / `parent.document` were one
// step away. Here the frame's origin is `htmlview://<token>` — same-origin
// WITHIN the frame's own scheme+host, but still CROSS-origin from the app
// (`tauri://localhost`) — so the ordinary Same-Origin Policy (not
// opaque-origin) is what now blocks `parent.document`/`frameElement`/IPC
// (design §10.3/§10.4).
//
// PER-OPEN TOKEN ORIGIN (design §10.3/§10.7): `arm_html_view_root` now
// returns a freshly-minted, unguessable token per open() call, and that
// token becomes the URL's HOST (`htmlViewUrl(token, docFileName)` —
// `htmlview://<token>/<doc file name>`), not just a path segment. Origin =
// (scheme, host), so every open gets its OWN origin — this is what closes
// the two risks same-origin would otherwise reopen: (a) two scripted
// documents open at once can no longer reach each other via
// `parent.frames`/window references (different hosts, SOP blocks it), and
// (b) `localStorage`/caches are scoped to the token's origin, so nothing
// persists or is shared across opens. The backend also narrows file access
// from "any armed directory" to "only THIS token's directory" — a stolen
// token is a strictly smaller blast radius than the old shared-scheme model.
//
// These two paths share the shell/zoom sink ONLY — never iframe creation,
// sandbox tokens, or source assignment (design §6: sharing that would let a
// conditional token assembly creep into the off path's "never a single
// allow-* token" promise).
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import {
  registerViewer,
  openViewerShell,
  readLocalFileBytes,
  htmlViewerScripts,
  type Viewer,
  type ViewerHandle,
  type ViewerShell,
} from "../../api";
import { decodeHtmlBytes, rewriteRelativeSrcAttrs } from "./prepare-html";
import { htmlViewUrl } from "./scripted-url";

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
/* NO width/height/max-* rule on .html-viewer itself (full-pane rewrite,
 * _workspace/01_architect_design.md §C: "콘텐츠 루트는 이제 아무 width/
 * height도 선언하지 않는다 — 셸 flex가 소유"). .html-viewer is openViewerShell's
 * paneClass — it lands on the SAME element as .viewer-panel (shell.ts's
 * pane.className = "<paneClass> viewer-panel"), not a separate content
 * wrapper, so .viewer-panel's own
 * "flex:1; min-width:0; min-height:0; display:flex; flex-direction:column"
 * (styles.css) already supplies this element's definite box — a second
 * width/height declaration here would just be re-stating the same rule on
 * the same node. This selector used to carry a fixed
 * "width: 92vw; height: 88vh; max-height: 88vh;" envelope of its own (a
 * vw/vh-fraction descendant of the pre-rewrite body-level backdrop/modal —
 * team-lead sizing fix, 2026-07, itself fixing an iframe-default-150px
 * collapse: pre-rewrite, .html-viewer was NOT .viewer-panel's own node, so
 * nothing else in that older chain carried a DEFINITE height). The
 * .html-viewer-frame-wrap child below still needs (and keeps) its own
 * "flex: 1; min-height: 0" to size the iframe against .viewer-panel-body's
 * (shell-owned) scroll boundary. */
/* The LOADED state's content wrapper — becomes the iframe's flex/scroll
 * boundary (mirrors excel-viewer-body's role: the outer .viewer-panel-body
 * (styles.css, shell-owned) gives every viewer's content a bounded flex
 * context to grow inside; this is the viewer's OWN flex-1/min-height:0
 * child inside that boundary, same two-layer contract Excel established). */
.html-viewer-frame-wrap { flex: 1; min-height: 0; overflow: hidden; display: flex; }
.html-viewer-frame { display: block; width: 100%; height: 100%; border: 0; background: #fff; }
.html-viewer-status { padding: 12px; color: var(--muted); font-size: 1em; }
/* Scripted-mode signal (design §5, _workspace/01_architect_design_htmljs.md)
 * — small/muted so it reads as metadata, not a warning; same visual register
 * as .sqlite-viewer-badge (styles.css), this extension's own copy since
 * src/extensions/** may not reach styles.css directly (api-fence). */
.html-viewer-js-badge {
  margin-left: 6px; font-size: 0.75em; padding: 1px 5px; border-radius: var(--radius-sm, 4px);
  color: var(--muted); background: color-mix(in srgb, var(--fg) 10%, transparent);
  vertical-align: middle;
}
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

/** The file name (last path segment) of an absolute path — a sibling of
 *  `parentDir` above, same local-copy reasoning (api-fence). Only the
 *  scripted path needs this: `htmlViewUrl(token, docFileName)` (design
 *  §10.7) takes the document's own file name, never the absolute path — the
 *  token already pins the directory server-side. Pure query. */
function fileName(path: string): string {
  const sep = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return sep >= 0 ? path.slice(sep + 1) : path;
}

/** Apply the parent-side zoom transform (full-pane rewrite design §B —
 *  iframe documents can't inherit a CSS custom property across the document
 *  boundary, so `.html-viewer-frame`'s own box is scaled from the OUTSIDE
 *  instead of injecting any font-size into `srcdoc`). Sizing the iframe UP by
 *  `1/scale` before scaling it DOWN by `scale` keeps its post-transform
 *  footprint exactly filling `.html-viewer-frame-wrap`, at any zoom level,
 *  without a reflow/reload of the document inside (scroll position
 *  survives). `scale` is the SHELL's viewer-local zoom factor
 *  (`shell.zoom.get()`), never fontScale — reused verbatim from before this
 *  round (v0.8.6's transform trick), only its SOURCE changed (below).
 *  Command (void) — a DOM mutation, not a query. */
function applyHtmlZoom(iframe: HTMLIFrameElement, scale: number): void {
  iframe.style.width = `calc(100% / ${scale})`;
  iframe.style.height = `calc(100% / ${scale})`;
  iframe.style.transform = `scale(${scale})`;
  iframe.style.transformOrigin = "0 0";
}

/** Wire `shell.zoom` → `iframe`'s parent-side transform — the ONE piece both
 *  open paths legitimately share (design §6: "셸·줌 sink만 공유"). Everything
 *  else about building/populating the iframe lives in the two path-specific
 *  functions below, never here. Command (void). */
function bindZoomSink(shell: ViewerShell, iframe: HTMLIFrameElement): void {
  // Zoom sink (full-pane rewrite, _workspace/01_architect_design.md §B —
  // supersedes the fontScale sink this used to be): observe the SHELL's own
  // viewer-local zoom, `shell.zoom` — the shell is the SINGLE WRITER
  // (`applyZoomFactor`, called only from the header's own −/+/label
  // handlers), this viewer only ever reads via `.get()`/`.bind()`, matching
  // every other viewer's sink shape (image/HWP/PDF). This is a DELIBERATE
  // fan-out removal, not a rename-in-place: the old `fontScale.bind(...)`
  // meant ⌘± (the editor's body-text zoom) ALSO resized every open HTML
  // viewer's iframe — exactly the coupling design §B's decision ③ rejects
  // ("뷰어 로컬, fontScaleSetting과 완전 분리"). `.bind` still applies the
  // CURRENT factor immediately (so a viewer opened after the shell already
  // zoomed starts correctly scaled) and again on every future change; its
  // unsubscribe is registered with the shell's teardown so it stops firing
  // after close().
  const unsubscribeZoom = shell.zoom.bind((factor) => applyHtmlZoom(iframe, factor));
  shell.onTeardown(unsubscribeZoom);
}

/** Show a load failure the same way both open paths do — a named function so
 *  the "never a silent stuck state" rule lives once. Command (void). */
function showOpenError(content: HTMLElement, err: unknown): void {
  content.replaceChildren();
  content.className = "html-viewer-status";
  content.textContent = `문서를 열 수 없습니다: ${err instanceof Error ? err.message : String(err)}`;
}

/** "is the scripted (JS-executing) open path armed for THIS open" — read
 *  EXACTLY ONCE per open() call, never re-read later (design §6: "설정은
 *  열기 시점에만 읽는다" — a toggle mid-session never reaches an already-open
 *  viewer; only the NEXT open() picks up the fresh value). Pure query. */
function scriptExecutionEnabled(): boolean {
  return htmlViewerScripts.get();
}

/** OFF path (design §6) — moved here verbatim from the pre-opt-in
 *  `openHtmlViewer`, logic UNCHANGED: fetch bytes → decode → rewrite relative
 *  asset src's → swap in an iframe whose `sandbox` is EXACTLY `""` and whose
 *  document is assigned via the `srcdoc` PROPERTY. This function owns its own
 *  iframe end to end — it shares nothing about iframe creation/sandbox/source
 *  with `openScriptedHtmlDocument` below (see this file's header comment: a
 *  shared iframe-build path is exactly where a stray allow-* token could
 *  creep into this path). Command. */
function openStaticHtmlDocument(absPath: string, shell: ViewerShell, content: HTMLElement): void {
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

  bindZoomSink(shell, iframe);

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
  })().catch((err) => showOpenError(content, err));
}

/** Scripted-mode signal (design §5): a small "JS" badge next to the viewer's
 *  title, so a document's script-execution state is never invisible from the
 *  chrome. The badge lives as a sibling of `shell.caption` in the title-bar's
 *  title slot — `shell.close()` already clears that slot wholesale
 *  (`titleSlot?.replaceChildren()`, shell.ts), so this needs no teardown of
 *  its own. Off mode never calls this — nothing is added. Command (void). */
function attachJsBadge(caption: HTMLElement): void {
  const badge = document.createElement("span");
  badge.className = "html-viewer-js-badge";
  badge.textContent = "JS";
  badge.title = "이 문서의 스크립트가 실행 중입니다";
  caption.insertAdjacentElement("afterend", badge);
}

/** ON path (design §2ⓔ/§3/§6/§10 REVISION 1) — gated entirely behind
 *  `scriptExecutionEnabled()`. Arms the backend's armed-root gate for this
 *  document's parent directory FIRST (`arm_html_view_root`, which now
 *  RETURNS a per-open token — design §10.7), then — only once that resolves
 *  — sets `sandbox="allow-scripts allow-same-origin"` (exactly these two
 *  tokens; see this file's header comment for why allow-same-origin is safe
 *  here, unlike the old srcdoc design) and loads the document by URL
 *  (`iframe.src = htmlViewUrl(token, fileName(absPath))`) through the
 *  `htmlview://<token>/…` custom-scheme handler — the token, not the
 *  absolute path, is what the URL host carries; the handler resolves the
 *  document's siblings against the directory THAT token was armed for.
 *  Deliberately does NOT use `srcdoc`/`decodeHtmlBytes`/`rewriteRelativeSrcAttrs`
 *  — a URL-loaded document gets its own base URL and handles its own
 *  `<meta charset>` natively (design §2's "부수 이득"), so none of the
 *  static path's byte-level prep applies here. Owns its own iframe end to
 *  end, same as `openStaticHtmlDocument` — see this file's header comment
 *  for why the two never share iframe construction. Command. */
function openScriptedHtmlDocument(absPath: string, shell: ViewerShell, content: HTMLElement): void {
  const iframe = document.createElement("iframe");
  iframe.className = "html-viewer-frame";

  bindZoomSink(shell, iframe);
  attachJsBadge(shell.caption);

  invoke<string>("arm_html_view_root", { dir: parentDir(absPath) })
    .then((token) => {
      // THE SECURITY-CRITICAL LINE for this path (design §10.3): exactly
      // these two tokens, never more. `allow-same-origin` makes the frame
      // same-origin with ITSELF (`htmlview://<token>`), never with the app
      // — see this file's header comment for the full argument.
      iframe.setAttribute("sandbox", "allow-scripts allow-same-origin");
      content.className = "html-viewer-frame-wrap";
      content.replaceChildren(iframe);
      // `src`, not `srcdoc` — this is what makes the document load through
      // the `htmlview://` handler (and its own, handler-issued CSP) instead
      // of inheriting the app's CSP (design §2's ⓔ decision). `fileName`,
      // not `absPath` — the token already pins the directory; only the doc's
      // own file name is left to name within it (design §10.7).
      iframe.src = htmlViewUrl(token, fileName(absPath));
    })
    .catch((err) => showOpenError(content, err));
}

/** Open `absPath` in the HTML viewer: shell up immediately with a loading
 *  status, then dispatch to the static or scripted open path (design §6) —
 *  the ONE branch point in this file, decided once per open() and never
 *  re-checked afterward. Mirrors excel-viewer's openExcelViewer shape
 *  (design §7 step 4). Command. */
function openHtmlViewer(absPath: string): ViewerHandle {
  ensureStyleInjected();
  const content = document.createElement("div");
  content.className = "html-viewer-status";
  content.textContent = "문서 불러오는 중…";

  const shell = openViewerShell({ absPath, paneClass: "html-viewer", content });

  if (scriptExecutionEnabled()) {
    openScriptedHtmlDocument(absPath, shell, content);
  } else {
    openStaticHtmlDocument(absPath, shell, content);
  }

  // onClose forwards the shell teardown so the OPENER learns about closes
  // it did not initiate (Esc / header ✕) — see ViewerHandle.onClose.
  return { close: () => shell.close(), onClose: (cb) => shell.onTeardown(cb) };
}

const HTML_VIEWER: Viewer = {
  id: "ext.html",
  extensions: ["html", "htm"],
  label: "HTML",
  open: openHtmlViewer,
};

/** Register the HTML viewer. Called once from activateExtensions() at boot
 *  (main.ts, before the first document mounts) — registerViewer's own
 *  duplicate-id guard makes a second call a developer error, matching every
 *  other registry in this codebase. Command (void). */
export function registerHtmlViewer(): void {
  registerViewer(HTML_VIEWER);
}
