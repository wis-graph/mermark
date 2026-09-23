// The source-code viewer (Stage C, `01_architect_plan.md`/`01_architect_design.md`
// — `ext.code`) — a fifth real viewer extension after Excel/HTML/PDF/Docx,
// living entirely behind the `../../api` facade (api-fence enforces this —
// tests/api-fence.test.ts). Registers through the same `registerViewer`
// every other viewer uses.
//
// BACKEND: zero new Tauri commands (design §0) — `readLocalFileBytes`/
// `readRemoteFileBytes` (../../api) already fetch a file's raw bytes,
// exactly like the docx/excel/html/pdf viewers.
//
// COLD LOAD (CLAUDE.md's constraint): `highlight.js` is dynamic-imported
// ONLY inside `open()`'s handler — never at module load / registerCodeViewer()
// time — so activateExtensions() (main.ts boot) never pulls it into the
// initial bundle. scripts/viewer-golden.mjs's gcode-1 scenario measures this
// via performance.getEntriesByType("resource").
//
// LINE-NUMBER STRATEGY (design §5): one `.code-viewer-line` element per
// source line, with the line number drawn by a CSS `::before` counter, never
// as DOM text — this is what keeps a copy/paste of the code from also
// copying line numbers (`::before` content is never part of the
// selection/clipboard in WebKit/Chromium), reinforced by `user-select: none`
// on the gutter number itself.
import {
  registerViewer,
  openViewerShell,
  readLocalFileBytes,
  readRemoteFileBytes,
  type Viewer,
  type ViewerHandle,
  type RemoteViewerSource,
} from "../../api";
import { languageForExtension, extensionOfPath, EXTRA_LANGUAGES, CODE_VIEWER_EXTENSIONS } from "./language-map";
import {
  looksBinary,
  decodeSourceText,
  splitLines,
  isDisplayable,
  sourceRenderPlan,
  splitHighlightedHtmlByLine,
  BINARY_FILE_MESSAGE,
  DISPLAY_TOO_LARGE_MESSAGE,
  HIGHLIGHT_DISABLED_MESSAGE,
} from "./source-text";
// A minimal shape of the hljs module surface this file actually calls — kept
// local (rather than `import type { HLJSApi } from "highlight.js"`) so this
// file's source text never contains ANY top-level `import ... "highlight.js`
// line, type-only included: the cold-load contract test greps for exactly
// that (mirrors pdf-viewer.ts's local `PdfjsModule`/docx-viewer's
// `DocxPreviewModule` pattern for the same reason).
interface HljsModuleApi {
  registerLanguage(name: string, fn: (hljs: unknown) => unknown): void;
  highlight(code: string, options: { language: string; ignoreIllegals?: boolean }): { value: string };
}

const STYLE_ID = "ext-code-viewer-style";

/** Inject this extension's own `<style>` once (idempotent) — extensions
 *  can't touch styles.css (api-fence spirit; docx/excel/html/pdf viewer
 *  precedent). CSP `style-src 'self' 'unsafe-inline'` (tauri.conf.json)
 *  already permits an inline element. Command (void). */
function ensureStyleInjected(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  // NO size envelope on `.code-viewer` (design §8: "콘텐츠 루트는 이제 아무
  // width/height도 선언하지 않는다 — 셸 flex가 소유"). `.code-viewer` is
  // openViewerShell's paneClass, landing on the SAME element as
  // `.viewer-panel` — tests/viewer-size-envelope.test.ts's content-root gate
  // asserts this file's injected CSS declares no width/height/max-* here.
  style.textContent = `
.code-viewer {
  --code-cmt: var(--muted);
  --code-kw: var(--link);
  --code-str: #a5d6a7;
  --code-num: #f4b183;
  --code-fn: #ffd479;
  --code-type: #9be0d8;
  --code-attr: #d7bde2;
}
:root[data-theme="light"] .code-viewer {
  --code-str: #1a7f37;
  --code-num: #b35900;
  --code-fn: #6f42c1;
  --code-type: #0f6f6f;
  --code-attr: #953800;
}
:root[data-theme="claude"] .code-viewer {
  --code-str: #4a7c59;
  --code-num: #b8562e;
  --code-fn: #6b4e9b;
  --code-type: #2f6f73;
  --code-attr: #8a5a2b;
}
.code-viewer-status { padding: 12px; color: var(--muted); font-size: 1em; }
.code-viewer-banner {
  padding: 6px 12px;
  color: var(--muted);
  font-size: 0.9em;
  border-bottom: 1px solid var(--border, rgba(128,128,128,0.2));
  flex: none;
}
.code-viewer-code {
  flex: 1; min-height: 0; overflow: auto;
  margin: 0; padding: 8px 0;
  font-family: var(--mono, ui-monospace, "SF Mono", Menlo, Consolas, monospace);
  font-size: calc(1em * var(--viewer-zoom, 1));
  line-height: 1.5;
  counter-reset: code-line;
}
.code-viewer-line {
  display: flex;
  white-space: pre;
  padding-right: 16px;
}
.code-viewer-line::before {
  counter-increment: code-line;
  content: counter(code-line);
  display: inline-block;
  flex: none;
  min-width: calc((var(--code-gutter-digits, 1) * 1ch) + 1.5ch);
  padding-right: 1ch;
  text-align: right;
  color: var(--muted);
  user-select: none;
  opacity: 0.6;
}
.code-viewer-line:hover { background: rgba(128,128,128,0.08); }
.hljs-comment, .hljs-quote { color: var(--code-cmt); font-style: italic; }
.hljs-keyword, .hljs-selector-tag, .hljs-doctag, .hljs-name { color: var(--code-kw); }
.hljs-string, .hljs-regexp, .hljs-addition { color: var(--code-str); }
.hljs-number, .hljs-literal, .hljs-symbol { color: var(--code-num); }
.hljs-title, .hljs-title.function_, .hljs-title.class_, .hljs-section { color: var(--code-fn); }
.hljs-type, .hljs-built_in, .hljs-selector-class, .hljs-selector-id { color: var(--code-type); }
.hljs-attr, .hljs-attribute, .hljs-variable, .hljs-template-variable, .hljs-property { color: var(--code-attr); }
.hljs-meta { color: var(--muted); }
.hljs-strong { font-weight: bold; }
.hljs-emphasis { font-style: italic; }
.hljs-deletion { color: var(--code-num); }
`;
  document.head.appendChild(style);
}

// Module-level cache Promise (mermaid-widget's `mermaidLoader` precedent) —
// the FIRST open() pays for `highlight.js/lib/common` + the extra
// dockerfile/dart grammars; every open() after that resolves instantly.
let hljsPromise: Promise<HljsModuleApi> | null = null;

/** Load `highlight.js/lib/common` + register the extra (non-common)
 *  grammars this viewer claims, exactly once for the process lifetime.
 *  Command (memoized). */
function hljsLoader(): Promise<HljsModuleApi> {
  if (!hljsPromise) {
    hljsPromise = (async () => {
      const [{ default: hljs }, ...extras] = await Promise.all([
        import("highlight.js/lib/common"),
        ...EXTRA_LANGUAGES.map((l) => l.load()),
      ]);
      EXTRA_LANGUAGES.forEach((extra, i) => hljs.registerLanguage(extra.name, extras[i].default));
      return hljs;
    })();
  }
  return hljsPromise;
}

/** Replace `content`'s children with a single status message (error/binary/
 *  too-large — html-viewer-status severity tier). Named so `open()`'s error
 *  path never re-implements this shape inline. Command (void). */
function showStatus(content: HTMLElement, text: string): void {
  content.className = "code-viewer-status";
  content.replaceChildren();
  content.textContent = text;
}

/** Append a bare "\n" text node between (never after) each `.code-viewer-line`
 *  row — collapsible whitespace between block boxes, so it renders as
 *  nothing visually (no CSS `white-space` is set on `.code-viewer-code`
 *  itself), while making `.code-viewer-code`'s `.textContent` reconstruct
 *  the EXACT original source (`decodeSourceText`'s output — no line-number
 *  text ever entering the DOM, since those come only from the `::before`
 *  counter, design §5). Command (void; mutates `frag`). */
function joinRowsWithNewlines(frag: DocumentFragment, rows: readonly HTMLElement[]): void {
  rows.forEach((row, i) => {
    if (i > 0) frag.appendChild(document.createTextNode("\n"));
    frag.appendChild(row);
  });
}

/** Build one `.code-viewer-line` element per line, un-highlighted
 *  (`textContent` only — this is the ONLY path raw source text ever reaches
 *  the DOM through, never `innerHTML`). Pure factory (no I/O). */
function renderPlainLines(lines: readonly string[]): DocumentFragment {
  const frag = document.createDocumentFragment();
  const rows = lines.map((line) => {
    const row = document.createElement("div");
    row.className = "code-viewer-line";
    row.textContent = line;
    return row;
  });
  joinRowsWithNewlines(frag, rows);
  return frag;
}

/** Build one `.code-viewer-line` element per line, already-hljs-escaped HTML
 *  (`innerHTML` — safe ONLY because hljs's own output contract guarantees
 *  every text node inside is already HTML-escaped, design §5). Pure factory. */
function renderHighlightedLines(lineHtmls: readonly string[]): DocumentFragment {
  const frag = document.createDocumentFragment();
  const rows = lineHtmls.map((html) => {
    const row = document.createElement("div");
    row.className = "code-viewer-line";
    row.innerHTML = html;
    return row;
  });
  joinRowsWithNewlines(frag, rows);
  return frag;
}

/** Open the code viewer against a bytes source: shell up immediately, fetch
 *  bytes (`getBytes` — see `openCodeViewer`/`openCodeViewerRemote` below),
 *  gate on size/binary-ness, decide `sourceRenderPlan`, and swap in the
 *  rendered lines (or a status message) when ready. `pathForCaption` is used
 *  only for the shell's basename caption and the extension→language lookup
 *  — never for IO. Mirrors docx-viewer's `openDocxViewerFromBytes` shape.
 *  Command. */
function openCodeViewerFromBytes(pathForCaption: string, getBytes: () => Promise<ArrayBuffer>): ViewerHandle {
  ensureStyleInjected();
  const content = document.createElement("div");
  content.className = "code-viewer-status";
  content.textContent = "파일 불러오는 중…";

  const shell = openViewerShell({ absPath: pathForCaption, paneClass: "code-viewer", content });

  let closed = false;
  shell.onTeardown(() => {
    closed = true;
  });

  (async () => {
    const bytes = await getBytes();
    if (closed) return;

    if (!isDisplayable(bytes.byteLength)) {
      showStatus(content, DISPLAY_TOO_LARGE_MESSAGE);
      return;
    }

    const sniff = new Uint8Array(bytes);
    if (looksBinary(sniff)) {
      showStatus(content, BINARY_FILE_MESSAGE);
      return;
    }

    const text = decodeSourceText(bytes);
    const lines = splitLines(text);
    const language = languageForExtension(extensionOfPath(pathForCaption));
    const plan = sourceRenderPlan({ language, byteLength: bytes.byteLength, lineCount: lines.length });

    let body: DocumentFragment;
    let banner: string | null = null;
    if (plan === "highlight") {
      const hljs = await hljsLoader();
      if (closed) return;
      const { value } = hljs.highlight(text, { language: language!, ignoreIllegals: true });
      body = renderHighlightedLines(splitHighlightedHtmlByLine(value));
    } else {
      body = renderPlainLines(lines);
      if (plan === "plain-too-large") banner = HIGHLIGHT_DISABLED_MESSAGE;
    }

    if (closed) return;
    content.className = "code-viewer-code";
    content.style.setProperty("--code-gutter-digits", String(String(lines.length).length));
    content.replaceChildren();
    if (banner) {
      const bannerEl = document.createElement("div");
      bannerEl.className = "code-viewer-banner";
      bannerEl.textContent = banner;
      content.appendChild(bannerEl);
    }
    content.appendChild(body);
  })().catch((err: unknown) => {
    if (closed) return;
    const message = err instanceof Error ? err.message : String(err);
    showStatus(content, `문서를 열 수 없습니다: ${message}`);
  });

  // NO shell.zoom.bind sink here (audit finding, design §5: "CSS로만 소비,
  // JS 0줄") — `.code-viewer-code`'s CSS already reads `var(--viewer-zoom,
  // 1)` directly, and shell.ts's `applyZoomFactor` already projects that
  // same variable onto the pane root (`.code-viewer` IS `.viewer-panel`,
  // the same element). A JS sink here would be a second writer of the exact
  // same custom property the shell already owns.
  return { close: () => shell.close(), onClose: (cb) => shell.onTeardown(cb) };
}

/** Open `absPath` (local) in the code viewer. Command. */
function openCodeViewer(absPath: string): ViewerHandle {
  return openCodeViewerFromBytes(absPath, () => readLocalFileBytes(absPath));
}

/** Open a remote vault's source file — same render pipeline, only the byte
 *  source differs (T6, 0.18.0 precedent). Command. */
function openCodeViewerRemote(source: RemoteViewerSource): ViewerHandle {
  return openCodeViewerFromBytes(source.path, () => readRemoteFileBytes(source));
}

const CODE_VIEWER: Viewer = {
  id: "ext.code", // NEVER-RENAME (registry.ts) — disabledViewersSetting persists this id
  extensions: CODE_VIEWER_EXTENSIONS,
  label: "소스 코드",
  open: openCodeViewer,
  openRemote: openCodeViewerRemote,
};

/** Register the code viewer. Called once from activateExtensions() at boot
 *  (main.ts, before the first document mounts) — registerViewer's own
 *  duplicate-id guard makes a second call a developer error, matching every
 *  other registry in this codebase. Command (void). */
export function registerCodeViewer(): void {
  registerViewer(CODE_VIEWER);
}
