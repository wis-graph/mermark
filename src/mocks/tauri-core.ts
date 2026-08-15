// Browser-only mock for @tauri-apps/api/core.
// Injected via Vite alias ONLY in `--mode browser` (see vite.config.ts).
// Lets the frontend run in a plain browser (Vite dev server) with no Rust backend,
// so CDP / Playwright / DevTools debugging works without WKWebView limits.

const SAMPLE = `# Mermark — markdown kitchen sink

Served by the **browser mock**, not the Rust backend. Edit it, hit save (⌘S) — changes round-trip in-memory until reload. This first paragraph is deliberately one long unbroken line with no hard wraps so you can confirm the reading column wraps soft text correctly and that the ~68ch measure holds: lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua ut enim ad minim veniam quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur excepteur sint occaecat cupidatat non proident sunt in culpa qui officia deserunt mollit anim id est laborum.

## Headings

### H3 level
#### H4 level
##### H5 level
###### H6 level

## Inline styles

**bold**, *italic*, ***bold italic***, ~~strikethrough~~, \`inline code\`, and a [labeled link](https://tauri.app). Autolink: https://github.com . Wikilink: [[some-note]] and an image wikilink: [[diagram.png]]. 외부 위키링크: [[https://example.com|외부]].

## Blockquote

> Top-level quote.
>
> > Nested quote with **bold** inside.

## Lists

Unordered, nested:

- Fruit
  - Apple
  - Pear
- Veg
  - Carrot

Ordered:

1. First
2. Second
   1. Second-a
   2. Second-b
3. Third

Task list:

- [x] Wire the browser mock
- [x] Fix baseDir char-eat bug
- [ ] Cover every markdown construct

## Table

| Feature   | Status | Note            |
| --------- | :----: | --------------- |
| Mermaid   |   ✅   | [문서](https://mermaid.js.org) |
| Math      |   ✅   | KaTeX           |
| Wikilinks |   ✅   | \`[[target]]\`    |

---

## Code block

\`\`\`ts
export function dirOf(path: string): string {
  const sep = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\\\"));
  return sep >= 0 ? path.slice(0, sep) : "";
}
\`\`\`

## Mermaid

\`\`\`mermaid
flowchart LR
  A[Browser] -- invoke --> B{mock}
  B -->|read_file| C[dummy md]
  B -->|write_file| D[in-memory]
\`\`\`

## Math

Inline $E = mc^2$ and block:

$$\\int_0^1 x^2\\,dx = \\frac{1}{3}$$

## Image

Local image (won't load in a plain browser — expected): ![local](./pic.png)
`;

// in-memory FS so write_file -> read_file round-trips during a session
const store = new Map<string, string>();

// --- Vault image attachment (single-window-opening Wave 2, Todo 5) ---
//
// mock-fidelity note (design §분기7): this simulates the FRONTEND-visible
// orchestration contract only — picker cancellation, deterministic collision
// suffixing, opaque token plumbing, and a content-snapshot stand-in for the
// native (dev,ino) identity check. It does NOT simulate atomicity
// (hard_link no-replace), real file bytes, or TempGuard cleanup — those are
// native properties only the cargo temp-vault integration tests
// (attachment_import.rs) can prove. "vitest green" here means the
// orchestration is wired correctly, not that the real import is safe.
interface MockAttachmentRecord {
  readonly relPath: string;
  readonly fileName: string;
  /** Stand-in for the native (dev,ino) identity captured at import time —
   *  compared against `attachmentStore`'s CURRENT value for this relPath at
   *  rollback time, the same "has this been replaced since?" question the
   *  real identity check answers. */
  readonly snapshot: string;
}
// relPath -> content snapshot ("bytes"). Never read as real file content —
// existence + snapshot-equality is all rollback/no-clobber need from it.
const attachmentStore = new Map<string, string>();
const attachmentReceipts = new Map<number, MockAttachmentRecord>();
let attachmentTokenSeq = 0;

// CLI file-open routing (Todo 2): every `acknowledge_open_request` invoke
// (see the case below) is recorded here, in call order, so golden/CDP
// scripts and manual dev:browser checks can assert a `cli-open-request` was
// actually acknowledged — the design's "emit success ≠ delivery" contract
// only holds if something observes the ack.
declare global {
  interface Window {
    __mockAcks?: { id: number; outcome: string }[];
    // Vault image attachment (single-window-opening Wave 2, Todo 5) test
    // hooks — see the import_vault_attachment/rollback_attachment_import
    // cases below for how each is consumed.
    __mockAttachPick?: string | null | (() => string | null);
    __mockRollbackFail?: boolean;
  }
}
window.__mockAcks = [];

// The path the (mock) watcher is currently armed on. Shared with the event mock
// (tauri-event.ts) so __mockExternalChange writes the simulated disk content
// into the in-memory store and emits a file-changed event for that path.
export let mockWatchedPath: string | null = null;
interface MockWatchSession {
  readonly path: string;
  readonly generation: string;
}
let mockWatchSession: MockWatchSession | null = null;
let mockWatcherGeneration = 0;

function beginMockWatch(path: string): MockWatchSession {
  const session = { path, generation: String(++mockWatcherGeneration) };
  mockWatchedPath = path;
  mockWatchSession = session;
  return session;
}

function clearMockWatch(): void {
  mockWatchedPath = null;
  mockWatchSession = null;
}

const smokeBridge = new URL(window.location.href).searchParams.get("smokeBridge");
const smokeToken = new URL(window.location.href).searchParams.get("smokeToken");
const SMOKE_BRIDGE_COMMANDS = new Set([
  "read_file",
  "write_file",
  "list_dir",
  "canonicalize_path",
  "directory_exists",
  "path_exists",
  "watch_file",
  "unwatch_file",
]);

async function invokeSmokeBridge(command: string, args: Args | undefined): Promise<Response | null> {
  if (!smokeBridge || !smokeToken || !SMOKE_BRIDGE_COMMANDS.has(command)) return null;
  return fetch(smokeBridge, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Mermark-Smoke-Token": smokeToken },
    body: JSON.stringify({ command, args: args ?? {} }),
  });
}
/** Simulate an external edit landing on the watched file: update the in-memory
 *  store so a subsequent read_file sees it, and return the payload the event
 *  mock should emit. Returns null when nothing is being watched. */
export function applyMockExternalChange(text: string): { readonly path: string; readonly generation: string; readonly text: string; readonly mtime: number } | null {
  if (mockWatchSession == null) return null;
  store.set(mockWatchSession.path, text);
  return { ...mockWatchSession, text, mtime: Date.now() };
}

// Minimal stubs of `@tauri-apps/api/core`'s `Resource`/`Channel` classes.
// `@tauri-apps/plugin-updater` does `import { Resource, Channel, invoke } from
// "@tauri-apps/api/core"` (its `Update` extends `Resource`, `download`/
// `downloadAndInstall` construct a `Channel`). Since this mock is aliased in
// for that whole module in `--mode browser` (see vite.config.ts), esbuild
// needs these named exports to resolve at all, or the dev:browser build fails
// before a single line of app code runs. The browser mock has no real update
// stream, so these only need to satisfy the shape `plugin-updater` touches —
// not reproduce the real message-ordering/resource-cleanup logic.
export class Resource {
  #rid: number;
  constructor(rid: number) {
    this.#rid = rid;
  }
  get rid(): number {
    return this.#rid;
  }
  async close(): Promise<void> {
    return invoke("plugin:resources|close", { rid: this.#rid });
  }
}

export class Channel<T = unknown> {
  id = 0;
  onmessage: (message: T) => void;
  constructor(onmessage?: (message: T) => void) {
    this.onmessage = onmessage ?? (() => {});
  }
}

type Args = Record<string, unknown> | undefined;

/** One directory entry — mirrors the Rust `DirEntry` serde shape exactly
 *  (`is_dir` stays snake_case on the wire). Kept local to the mock so the
 *  browser tree lookup is typed the same as `invoke<DirEntry[]>("list_dir")`. */
interface DirEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

/** Fold a trailing `/..` textually so the mock's `list_dir` tree lookup matches
 *  the real backend's `normalize_path` parent resolution (the explorer's `..`
 *  double-click passes `${root}/..`). Only the cases the fixed TREE needs are
 *  handled — this is a deterministic stand-in, not a full path normalizer. */
function normalizeMockPath(path: string): string {
  const parts = path.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "..") out.pop();
    else if (part === "." || part === "") continue;
    else out.push(part);
  }
  return "/" + out.join("/");
}

/** The mock's fixed directory tree, keyed by normalized path. Shared by
 *  `list_dir` (one-level lookup) and `list_files_recursive` (recursive walk
 *  over the same keys) so the two commands can never see a different
 *  filesystem in the mock — same single-source-of-truth reasoning as the
 *  real backend reusing `is_hidden_entry`/`is_mermark_artifact` for both. */
const TREE: Record<string, DirEntry[]> = {
  "/mock/vault": [
    // .config sorts first within the folder group (ascii '.' < letters),
    // matching the real backend's dir_entry_sort_key. Dotfile — filtered
    // below unless showHidden. Never add a `*.mermark-tmp.*`/
    // `*.mermark-recovered` row here: the artifact-exclusion invariant is
    // expressed by ABSENCE in this mock (filter can't un-invariant it),
    // mirroring commands.rs's unconditional `is_mermark_artifact` check.
    { name: ".config", path: "/mock/vault/.config", is_dir: true },
    { name: "notes", path: "/mock/vault/notes", is_dir: true },
    // .hidden-note.md sorts first within the file group, same reason.
    { name: ".hidden-note.md", path: "/mock/vault/.hidden-note.md", is_dir: false },
    { name: "index.md", path: "/mock/vault/index.md", is_dir: false },
    // txt-as-md (_workspace/01_architect_design_txt.md): mermark opens .txt
    // in the same editor/live-preview as .md, so it needs a row here to
    // exercise that path in dev:browser — read_file/write_file/open_path
    // are extension-agnostic already, this fixture just makes the file
    // visible/openable/searchable.
    { name: "plain.txt", path: "/mock/vault/plain.txt", is_dir: false },
    { name: "logo.svg", path: "/mock/vault/logo.svg", is_dir: false },
    { name: "data.json", path: "/mock/vault/data.json", is_dir: false },
    { name: "app.ts", path: "/mock/vault/app.ts", is_dir: false },
    // PDF viewer golden (G14 — lazy render + MAX_RENDERED_PAGES canvas-
    // eviction cap): "guide.pdf" predates the PDF viewer's existence
    // (this row used to have no backing file — a dummy icon/list-only
    // entry) and REGRESSED to an error panel the moment
    // registerPdfViewer() started claiming "pdf" (readLocalFileBytes
    // 404 against a nonexistent file). Fixed by backing it with a REAL
    // 25-page fixture (scripts/lib/make-pdf-fixture.mjs →
    // mock-assets/mock/vault/guide.pdf, pages marked "PAGE 1".."PAGE 25"
    // so a golden can assert exactly which page rendered) instead of
    // adding a third PDF row — this TREE entry only makes the row
    // visible/openable; bytes are served by Vite's browser-mode publicDir.
    { name: "guide.pdf", path: "/mock/vault/guide.pdf", is_dir: false },
    { name: "LICENSE", path: "/mock/vault/LICENSE", is_dir: false },
    { name: "pic.png", path: "/mock/vault/pic.png", is_dir: false },
    // R11 (_workspace/01_r11.md §9 Step 5): the Excel-viewer golden's
    // positive fixture. Bytes are served by Vite's browser-mode
    // publicDir (vite.config.ts) at mock-assets/mock/vault/report.xlsx
    // — this TREE entry only makes the row visible/openable; it never
    // reads the file itself (list_dir doesn't touch content).
    { name: "report.xlsx", path: "/mock/vault/report.xlsx", is_dir: false },
    // R11 2단계 (_workspace/01_html_viewer.md §8): the HTML-viewer
    // golden's positive fixture (G7~G9). Same shape as report.xlsx
    // above — bytes served by Vite's browser-mode publicDir at
    // mock-assets/mock/vault/{sample.html,sample-asset.png}; this TREE
    // entry only makes the rows visible/openable in the explorer.
    { name: "sample.html", path: "/mock/vault/sample.html", is_dir: false },
    { name: "sample-asset.png", path: "/mock/vault/sample-asset.png", is_dir: false },
    // HWP viewer golden (_workspace/01_hwp_viewer.md §9 G10~G12): three
    // rows dispatched by *name* in the hwp_open/hwp_render_page cases
    // below (there's no real HWP parser here, so no real bytes are
    // needed for these to be openable) — normal / corrupted / oversized.
    { name: "sample.hwp", path: "/mock/vault/sample.hwp", is_dir: false },
    { name: "corrupt.hwp", path: "/mock/vault/corrupt.hwp", is_dir: false },
    { name: "huge.hwp", path: "/mock/vault/huge.hwp", is_dir: false },
    // PDF viewer golden (G13): the 1-page positive fixture (basic
    // render/text-layer). Same shape as report.xlsx/sample.html above
    // — bytes served by Vite's browser-mode publicDir at
    // mock-assets/mock/vault/sample.pdf (scripts/lib/make-pdf-fixture.mjs);
    // this TREE entry only makes the row visible/openable in the
    // explorer. "guide.pdf" (above) is the 25-page fixture for G14.
    { name: "sample.pdf", path: "/mock/vault/sample.pdf", is_dir: false },
    // SQLite viewer golden: the positive fixture. Unlike report.xlsx/
    // sample.html, the sqlite_* commands never read file bytes (they're
    // dispatched purely by the `table` arg against SQLITE_SCHEMA above),
    // so no bytes need to be served by Vite's publicDir — this TREE
    // entry only makes the row visible/openable in the explorer.
    { name: "demo.sqlite", path: "/mock/vault/demo.sqlite", is_dir: false },
    // docx viewer golden (G-docx-1..4, 01_architect_plan.md §골든마스터
    // 시나리오): the positive fixture. Same shape as report.xlsx/
    // sample.pdf above — bytes served by Vite's browser-mode publicDir
    // at mock-assets/mock/vault/sample.docx
    // (scripts/lib/make-docx-fixture.mjs); this TREE entry only makes
    // the row visible/openable in the explorer.
    { name: "sample.docx", path: "/mock/vault/sample.docx", is_dir: false },
  ],
  "/mock/vault/notes": [
    { name: "a.md", path: "/mock/vault/notes/a.md", is_dir: false },
  ],
  // Empty so expanding .config while showHidden=on doesn't error.
  "/mock/vault/.config": [],
  "/mock": [
    // `..` from /mock/vault lands here — the parent listing.
    { name: "vault", path: "/mock/vault", is_dir: true },
  ],
};

// --- SQLite DB viewer (native rusqlite backend, read-only) ---

/** Fixed per-table schema for the mock's SQLite fixture (demo.sqlite):
 *  columns/columnTypes/rowCount, mirroring the real `sqlite_table_info`'s
 *  camelCase serde shape exactly (`columnTypes`/`rowCount` — the fixed IPC
 *  contract `sqlite-viewer.ts` reads). `users` is deliberately larger than
 *  the viewer's 100-row page size so scroll-pagination is exercised by the
 *  golden; `orders` and `active_users` (a view) stay small so a single
 *  no-scroll tab is also covered. There is no real SQLite file behind this
 *  — unlike report.xlsx/sample.html, these commands never read file bytes,
 *  they're dispatched purely by `table` name, so no fixture bytes need to
 *  be served by Vite's browser-mode publicDir. */
const SQLITE_SCHEMA: Record<string, { columns: string[]; columnTypes: string[]; rowCount: number }> = {
  users: {
    columns: ["id", "name", "email", "age", "created"],
    columnTypes: ["INTEGER", "TEXT", "TEXT", "INTEGER", "TEXT"],
    rowCount: 250, // > the 100-row page size, so scroll-pagination is exercised
  },
  orders: {
    columns: ["id", "user_id", "total", "placed_at", "receipt"],
    columnTypes: ["INTEGER", "INTEGER", "REAL", "TEXT", "BLOB"],
    rowCount: 12,
  },
  active_users: {
    columns: ["id", "name", "email"],
    columnTypes: ["INTEGER", "TEXT", "TEXT"],
    rowCount: 5,
  },
};

/** One synthetic row for `table` at zero-based index `i`, as the
 *  `(string | null)[]` shape the real `sqlite_rows` returns: a NULL cell
 *  every few rows, an integer/real rendered as a display string (never a
 *  JSON number), and — on "orders" — a BLOB cell rendered as the same
 *  `"BLOB ({n} bytes)"` placeholder the real backend produces. Enough
 *  variety for the viewer's per-column-type rendering (NULL styling, right-
 *  aligned numeric columns, BLOB text) to be exercised without a real
 *  rusqlite connection. */
function mockSqliteRow(table: string, i: number): (string | null)[] {
  switch (table) {
    case "users":
      return [
        String(i + 1),
        `User ${i + 1}`,
        i % 6 === 5 ? null : `user${i + 1}@example.com`,
        String(20 + (i % 50)),
        `2024-${String((i % 12) + 1).padStart(2, "0")}-01`,
      ];
    case "orders":
      return [
        String(i + 1),
        i % 4 === 3 ? null : String((i % 5) + 1),
        (9.99 + i).toFixed(2),
        `2024-06-${String((i % 28) + 1).padStart(2, "0")}`,
        i % 3 === 0 ? `BLOB (${12 + i} bytes)` : null,
      ];
    case "active_users":
      return [String(i + 1), `Active ${i + 1}`, `active${i + 1}@example.com`];
    default:
      return [];
  }
}

// --- HWP/HWPX viewer (native rhwp backend, _workspace/01_hwp_viewer.md) ---

// Page count for the mock's "normal" HWP fixture (sample.hwp). Fixed so
// hwp_render_page can bounds-check page numbers the same way the real
// backend does (page >= pages -> Err), and so the golden's placeholder-count
// assertion (G10) is deterministic.
const HWP_MOCK_PAGE_COUNT = 3;

/** One deterministic SVG per page: a fixed A4-ish rect plus a `HWP-PAGE-{n}`
 *  marker <text>, so a golden script can prove page 1 was actually the page
 *  lazily rendered — not just "some SVG rendered". Page 1 additionally
 *  carries G11's adversarial payload (a `<script>` tag *and* an `onload`
 *  probe) so the golden can assert neither ever fires once this string is
 *  only ever placed as an `<img src="data:image/svg+xml;base64,…">` — a
 *  spec-level sandbox stronger than sanitizing markup (§4.1). */
function mockHwpPageSvg(page: number): string {
  const marker = `HWP-PAGE-${page}`;
  const probe =
    page === 1
      ? `<script>window.__HWP_PWNED=1<\/script><rect width="1" height="1" onload="window.__HWP_PWNED_ONLOAD=1"/>`
      : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="595" height="842">${probe}<text x="20" y="40">${marker}</text></svg>`;
}

export async function invoke<T = unknown>(cmd: string, args?: Args): Promise<T> {
  const a = (args ?? {}) as Record<string, unknown>;
  // strip plugin prefix e.g. "plugin:opener|open_url" -> "open_url"
  const name = cmd.includes("|") ? cmd.split("|")[1] : cmd;

  const smokeResponse = await invokeSmokeBridge(name, args);
  if (smokeResponse) {
    if (!smokeResponse.ok) throw new Error(await smokeResponse.text());
    const result: unknown = await smokeResponse.json();
    if (name === "watch_file") return beginMockWatch(String(a.path ?? "")) as T;
    if (name === "unwatch_file") clearMockWatch();
    return result as T;
  }

  switch (name) {
    case "read_file": {
      const path = String(a.path ?? "");
      const text = store.get(path) ?? SAMPLE;
      return { text, mtime: Date.now() } as T;
    }
    case "write_file": {
      store.set(String(a.path ?? ""), String(a.text ?? ""));
      console.info("[mock] write_file", a.path, `${String(a.text ?? "").length} chars`);
      // mirror the real command: return the new mtime (no conflict in-memory)
      return Date.now() as T;
    }
    case "bundle_doc": {
      // Mirrors the real `bundle_doc(path) -> Result<String, String>`: returns
      // the LLM bundle envelope as a string. Deterministic so golden/clipboard
      // checks are stable. The browser mock can't traverse a real FS, so it
      // wraps just the requested doc (root-only) in the same <documents> shape.
      const path = String(a.path ?? "");
      const title = (path.split("/").pop() ?? path).replace(/\.md$/i, "");
      const rel = path.split("/").pop() ?? path;
      const body = store.get(path) ?? SAMPLE;
      console.info("[mock] bundle_doc", path);
      return `<documents>\n<document path="${rel}" title="${title}">\n${body}\n</document>\n</documents>` as T;
    }
    case "list_link_targets": {
      // Mirrors the real `list_link_targets(dir) -> Result<Vec<LinkTarget>>`:
      // markdown notes (name = basename, no `.md`) and inlineable images
      // (name = full file name) in the given dir, sorted markdown-first then by
      // name. Deterministic so the `[[` picker golden is stable; the values line
      // up with the SAMPLE body's `[[some-note]]` and `[[diagram.png]]`. The
      // browser mock can't read a real FS, so `dir` is accepted but ignored.
      // plain.txt mirrors the real classify_link_target's txt branch
      // (commands.rs): kind stays "markdown" (txt opens the same as md), but
      // `name` is the FULL filename (not a stem) — inserting "plain" would
      // resolve back to "plain.md" (wikilinkPath's default-extension rule),
      // an entirely different file. See _workspace/01_architect_design_txt.md
      // §B1.
      console.info("[mock] list_link_targets", a.dir);
      return [
        { name: "some-note", rel: "some-note.md", kind: "markdown" },
        { name: "plain.txt", rel: "plain.txt", kind: "markdown" },
        { name: "diagram.png", rel: "diagram.png", kind: "image" },
      ] as T;
    }
    case "list_dir": {
      // Mirrors the real `list_dir(path, show_hidden) -> Result<Vec<DirEntry>>`:
      // the immediate children (one level) of `path`, folders first then name,
      // mermark artifacts always excluded, dotfiles excluded unless showHidden.
      // The browser has no real FS, so the lazy tree is faked with a
      // deterministic per-path lookup — nested hover walks the table. Parent
      // (`..`) resolution is folded by normalizeMockPath, mirroring the
      // backend's normalize_path so `${root}/..` lands on the parent key.
      // `is_dir` stays snake_case to match the Rust serde shape. Roots align with
      // the golden's `?file=/mock/vault/index.md` entry point.
      const showHidden = a.showHidden === true;
      const norm = normalizeMockPath(String(a.path ?? ""));
      const entries = TREE[norm] ?? [];
      const result = showHidden ? entries : entries.filter((e) => !e.name.startsWith("."));
      console.info("[mock] list_dir", a.path, "showHidden", showHidden, "->", norm);
      return result as T;
    }
    case "list_files_recursive": {
      // Mirrors the real `list_files_recursive(root, show_hidden) ->
      // Result<ScanResult, String>` (⌘⇧F fuzzy file-finder). The browser mock
      // has no real recursive FS walk, so it flattens the same fixed TREE the
      // list_dir case above uses — walking every key that sits at or below
      // `norm`, applying the identical dotfile/show_hidden policy and folder
      // exclusion (`.config`/`.git`/`node_modules`-style names) so the two
      // commands stay behaviorally consistent in the mock, same as the real
      // backend reusing is_hidden_entry/is_mermark_artifact for both. `rel_path`
      // stays snake_case to match the Rust serde shape (FileHit); ScanResult's
      // `truncated` is always false here — the fixture tree is tiny, nowhere
      // near MAX_SCAN_FILES/MAX_SCAN_DEPTH.
      const showHidden = a.showHidden === true;
      const norm = normalizeMockPath(String(a.root ?? ""));
      const EXCLUDED_SCAN_DIRS = new Set(["node_modules", ".git", "target", "dist", "build", "__pycache__", ".venv"]);
      const files: { name: string; path: string; rel_path: string }[] = [];
      const visited = new Set<string>();
      const walk = (dirPath: string, relPrefix: string) => {
        if (visited.has(dirPath)) return; // cycle guard, mirrors symlink-dir non-follow
        visited.add(dirPath);
        const entries = TREE[dirPath] ?? [];
        for (const e of entries) {
          if (!showHidden && e.name.startsWith(".")) continue; // is_hidden_entry policy
          const rel = relPrefix ? `${relPrefix}/${e.name}` : e.name;
          if (e.is_dir) {
            if (EXCLUDED_SCAN_DIRS.has(e.name)) continue; // unconditional, like is_excluded_scan_dir
            walk(e.path, rel);
          } else {
            files.push({ name: e.name, path: e.path, rel_path: rel });
          }
        }
      };
      walk(norm, "");
      files.sort((x, y) => (x.rel_path < y.rel_path ? -1 : x.rel_path > y.rel_path ? 1 : 0));
      console.info("[mock] list_files_recursive", a.root, "showHidden", showHidden, "->", norm, files.length, "files");
      return { files, truncated: false } as T;
    }
    case "watch_file":
      // Single-slot fs watcher. No real watcher in the browser — record the
      // path so __mockExternalChange (in the event mock) can target it, and
      // no-op otherwise. The real backend replaces any prior watch here.
      console.info("[mock] watch_file", a.path);
      return beginMockWatch(String(a.path ?? "")) as T;
    case "unwatch_file":
      clearMockWatch();
      console.info("[mock] unwatch_file");
      return undefined as T;
    case "resolve_image": {
      // Mirrors the real `resolve_image(base_dir, name, max_depth) -> Option<String>`
      // (serde `string | null`). The browser has no filesystem to recurse, so the
      // scan is faked with a deterministic lookup table keyed on the reference's
      // basename: a known image name resolves to a fixed `/mock/found/...` path,
      // everything else resolves to null (not found). This lets the golden master
      // exercise the fallback path deterministically — the SAMPLE body's
      // `![local](./pic.png)` fails its literal load in a plain browser, the widget
      // calls resolve_image with name "./pic.png", and the basename "pic.png" maps
      // here to "/mock/found/pic.png", which convertFileSrc returns verbatim so the
      // swapped `img.src` is observable in the DOM. Args are camelCase to match the
      // Tauri snake→camel mapping: { baseDir, name, maxDepth }.
      const baseDir = String(a.baseDir ?? "");
      const name = String(a.name ?? "");
      const basename = name.split(/[/\\]/).pop() ?? name;
      const FOUND: Record<string, string> = {
        "pic.png": "/mock/found/pic.png",
      };
      const hit = FOUND[basename.toLowerCase()] ?? null;
      console.info("[mock] resolve_image", baseDir, name, "->", hit);
      return hit as T;
    }
    case "hwp_open": {
      // Mirrors the real `hwp_open(path) -> Result<HwpOpenInfo, String>`. The
      // browser mock has no real parser/filesystem, so it dispatches purely
      // on fixture *name*, reproducing the design's 3-case contract
      // (§3.4): normal (page count) / corrupted (Err) / oversized (Err, the
      // same cap-message shape `assert_hwp_file_within_cap` produces).
      const path = String(a.path ?? "");
      const basename = path.split(/[/\\]/).pop() ?? path;
      console.info("[mock] hwp_open", path);
      if (basename === "corrupt.hwp") {
        throw "HWP 파일 파싱 오류: 유효하지 않은 파일: mock corrupt fixture";
      }
      if (basename === "huge.hwp") {
        throw "파일이 너무 큽니다: 104857601 bytes (상한 104857600 bytes)";
      }
      return { pages: HWP_MOCK_PAGE_COUNT } as T;
    }
    case "hwp_render_page": {
      // Mirrors the real `hwp_render_page(page) -> Result<String, String>`
      // (an SVG string). Bounds-checked the same way the backend does —
      // out-of-range page -> Err — using HWP_MOCK_PAGE_COUNT as the stand-in
      // for "the session hwp_open reported" (the mock keeps no session state).
      const page = Number(a.page ?? 0);
      if (!Number.isInteger(page) || page < 0 || page >= HWP_MOCK_PAGE_COUNT) {
        throw `페이지 범위 초과: ${page} (전체 ${HWP_MOCK_PAGE_COUNT}페이지)`;
      }
      console.info("[mock] hwp_render_page", page);
      return mockHwpPageSvg(page) as T;
    }
    case "hwp_close":
      // Mirrors the real `hwp_close(state)`: idempotent, no return value.
      console.info("[mock] hwp_close");
      return undefined as T;
    case "sqlite_tables": {
      // Mirrors the real `sqlite_tables(path) -> Result<Vec<SqliteObject>>`:
      // tables first, then views, each group alphabetical. Deterministic and
      // independent of `path` (the mock has no real file to scan).
      console.info("[mock] sqlite_tables", a.path);
      return [
        { name: "orders", kind: "table" },
        { name: "users", kind: "table" },
        { name: "active_users", kind: "view" },
      ] as T;
    }
    case "sqlite_table_info": {
      // Mirrors the real `sqlite_table_info(path, table) -> Result<SqliteTableInfo>`
      // (camelCase `columnTypes`/`rowCount`, per the fixed contract).
      const table = String(a.table ?? "");
      const info = SQLITE_SCHEMA[table];
      console.info("[mock] sqlite_table_info", a.path, table);
      if (!info) throw `table not found: ${table}`;
      return { columns: info.columns, columnTypes: info.columnTypes, rowCount: info.rowCount } as T;
    }
    case "sqlite_rows": {
      // Mirrors the real `sqlite_rows(path, table, limit, offset) ->
      // Result<Vec<Vec<Option<String>>>>`: a real LIMIT/OFFSET slice of the
      // table's synthetic rows, empty once `offset` reaches `rowCount` — so
      // the frontend's "stop requesting more pages" logic has a real signal
      // to react to, not just an ever-repeating mock.
      const table = String(a.table ?? "");
      const limit = Number(a.limit ?? 0);
      const offset = Number(a.offset ?? 0);
      const info = SQLITE_SCHEMA[table];
      console.info("[mock] sqlite_rows", a.path, table, limit, offset);
      if (!info || offset >= info.rowCount) return [] as T;
      const end = Math.min(offset + limit, info.rowCount);
      const rows: (string | null)[][] = [];
      for (let i = offset; i < end; i++) rows.push(mockSqliteRow(table, i));
      return rows as T;
    }
    case "copy_to_clipboard":
      // Mirrors the real `copy_to_clipboard(text) -> Result<(), String>`, but
      // fire-and-forget and always-successful: dev:browser (http origin,
      // secure context) has a real clipboard, so this actually writes to it
      // for manual developer verification, but a rejected write (no focus, no
      // permission under CDP/headless) is swallowed rather than propagated —
      // the golden must stay deterministic regardless of the browser's
      // clipboard-permission state. Same "simulate the effect, report success"
      // pattern as the watch_file stub above.
      void navigator.clipboard?.writeText(String(a.text ?? "")).catch(() => {});
      console.info("[mock] copy_to_clipboard", `${String(a.text ?? "").length} chars`);
      return undefined as T;
    case "arm_html_view_root": {
      // Mirrors the real `arm_html_view_root(dir) -> Result<String, String>`
      // (_workspace/01_architect_design_htmljs.md §10.7 — 개정 1 changed the
      // return type from `()` to a minted token string; see
      // _workspace/02_backend_changes_htmljs.md §11 for the full contract).
      // The browser mock has no `htmlview://` protocol handler and no real
      // token→root filesystem gate — the scripted HTML viewer path instead
      // loads `htmlViewUrl()`'s same-origin mock URL directly from Vite's
      // browser-mode publicDir, so this mock hands back a **fixed** token
      // string rather than minting a real random one (determinism for
      // golden/spy assertions matters more here than unguessability, unlike
      // the real backend). Fixed, not random, so `tests/html-viewer.test.ts`
      // can assert the exact value `openScriptedHtmlDocument` folds into the
      // `iframe.src` it builds (spy-return-value assertion, plan §RED-F5).
      const token = "mock-view-token";
      console.info("[mock] arm_html_view_root", a.dir, "->", token);
      return token as T;
    }
    case "arm_epub_view": {
      // Mirrors the real `arm_epub_view(path) -> Result<String, String>`
      // (_workspace/01_architect_design_epub.md §2). There is no `epub://`
      // scheme registered in a plain browser (WKWebView-only custom scheme
      // handler — the same `wkwebview-custom-scheme-test-gap` limitation
      // documented for `arm_html_view_root`), so unlike that mock (which
      // hands back a fixed token to let a same-origin mock document load),
      // the EPUB reader has nothing to load *into* even with a token — this
      // mock rejects outright rather than returning a token that would only
      // ever 404. Silent success here would make the EPUB viewer's open
      // flow look like it works under CDP/DevTools when it structurally
      // cannot (design plan §알려진 한계).
      console.info("[mock] arm_epub_view", a.path, "-> rejected (no epub:// scheme in browser dev)");
      throw "EPUB 뷰어는 브라우저 dev에서 지원되지 않습니다 (epub:// 스킴 없음)";
    }
    case "read_epub_entry": {
      // Mirrors the real `read_epub_entry(token, entry) -> Result<String, String>`.
      // Same rationale as arm_epub_view above: no real zip-backed token
      // exists in the browser mock, so any call here (which can only follow
      // a real token from a real arm_epub_view — itself always rejected
      // above) is refused rather than fabricating XML content.
      console.info("[mock] read_epub_entry", a.token, a.entry, "-> rejected (no epub:// scheme in browser dev)");
      throw "EPUB 뷰어는 브라우저 dev에서 지원되지 않습니다 (epub:// 스킴 없음)";
    }
    case "register_window_ready":
      // Mirrors the real `register_window_ready(window, state)`: a void
      // command whose only real effect is marking this webview's label ready
      // in the backend's single-instance broker, so it starts receiving
      // `cli-open-request` deliveries. The browser mock has no such broker —
      // registerCliOpenRouting() in main.ts calls this after listen() purely
      // to keep the listen→ready ordering contract exercised under
      // dev:browser too.
      console.info("[mock] register_window_ready");
      return undefined as T;
    case "acknowledge_open_request": {
      // Mirrors the real `acknowledge_open_request(window, state, id, outcome)`.
      // The mock has no request queue to pop, so it just records the ack on
      // window.__mockAcks — the observation hook golden/CDP scripts and
      // manual dev:browser checks use to confirm a request was actually
      // acknowledged (not just that the emit succeeded; emit success ≠
      // delivery per the design contract).
      const id = Number(a.id ?? -1);
      const outcome = String(a.outcome ?? "");
      console.info("[mock] acknowledge_open_request", id, outcome);
      window.__mockAcks?.push({ id, outcome });
      return undefined as T;
    }
    case "path_exists":
      return true as T;
    case "directory_exists":
      return true as T;
    case "canonicalize_path":
      return normalizeMockPath(String(a.path ?? "")) as T;
    case "open_path": {
      // Mirrors the real `open_path(path) -> Result<(), String>`: spawns the
      // file in a brand-new window (wikilink clicks, explorer ⌘/Ctrl+click,
      // ⌘+Enter). The browser mock has no real webview windows to spawn, so it
      // falls back to a new browser tab carrying the same `?file=` query the
      // real backend's window URL uses — close enough to exercise the flow
      // under CDP/DevTools debugging.
      const path = String(a.path ?? "");
      console.info("[mock] open_path ->", path);
      window.open(`?file=${encodeURIComponent(path)}`, "_blank");
      return undefined as T;
    }
    case "open_url":
      console.info("[mock] open_url", a.url);
      return undefined as T;
    case "import_vault_attachment": {
      // Mirrors the real `import_vault_attachment(vault_root) ->
      // Result<AttachmentImportOutcome, String>`. The browser mock has no
      // native file dialog, so `window.__mockAttachPick` stands in for the
      // user's picker choice: `null`/unset -> cancelled (no import code
      // reached, matching the real command's "None -> Ok{cancelled}" shape),
      // a string -> the "picked" source path (never actually read — the mock
      // has no real bytes to copy). Candidate naming reproduces the real
      // `attachment_file_name` decision: n=0 keeps the basename, n>=1 inserts
      // `-{n}` before the extension, retried only while the slot is taken —
      // same no-clobber contract, just against `attachmentStore` instead of
      // a real `.attachments` directory.
      const pick = typeof window.__mockAttachPick === "function" ? window.__mockAttachPick() : (window.__mockAttachPick ?? null);
      console.info("[mock] import_vault_attachment", a.vaultRoot, "-> picked", pick);
      if (pick === null || pick === undefined) return { status: "cancelled" } as T;
      const picked = String(pick);
      const name = picked.split(/[/\\]/).pop() ?? picked;
      const dot = name.lastIndexOf(".");
      const stem = dot <= 0 ? name : name.slice(0, dot);
      const ext = dot <= 0 ? "" : name.slice(dot + 1);
      let n = 0;
      let fileName = name;
      let relPath = `.attachments/${fileName}`;
      while (attachmentStore.has(relPath)) {
        n += 1;
        fileName = ext ? `${stem}-${n}.${ext}` : `${stem}-${n}`;
        relPath = `.attachments/${fileName}`;
      }
      const snapshot = `mock-bytes:${picked}`;
      attachmentStore.set(relPath, snapshot);
      const token = ++attachmentTokenSeq;
      attachmentReceipts.set(token, { relPath, fileName, snapshot });
      console.info("[mock] import_vault_attachment -> imported", relPath, "token", token);
      return { status: "imported", receipt: { token, relPath, fileName } } as T;
    }
    case "finalize_attachment_import": {
      // Mirrors the real `finalize_attachment_import(token) -> Result<(),
      // String>`: drop the receipt record only — the file (attachmentStore
      // entry) stays, now permanent. Idempotent on an unknown token, same as
      // the real command.
      const token = Number(a.token ?? -1);
      attachmentReceipts.delete(token);
      console.info("[mock] finalize_attachment_import", token);
      return undefined as T;
    }
    case "rollback_attachment_import": {
      // Mirrors the real `rollback_attachment_import(token) -> Result<(),
      // String>`. `window.__mockRollbackFail` simulates a native ROLLBACK_IO
      // failure (vitest exercises design failure 보조a without needing a real
      // unremovable file). An unknown token is always ROLLBACK_UNKNOWN — the
      // mock never guesses. A snapshot mismatch (attachmentStore's current
      // value for relPath differs from what was captured at import time)
      // simulates the identity-changed guard: reject ROLLBACK_CHANGED and
      // preserve the file, exactly like the real (dev,ino) check.
      const token = Number(a.token ?? -1);
      const record = attachmentReceipts.get(token);
      console.info("[mock] rollback_attachment_import", token, record ? record.relPath : "(unknown token)");
      if (!record) throw `ROLLBACK_UNKNOWN: ${token}`;
      if (window.__mockRollbackFail) throw `ROLLBACK_IO: ${record.relPath}`;
      if (attachmentStore.get(record.relPath) !== record.snapshot) {
        attachmentReceipts.delete(token);
        throw `ROLLBACK_CHANGED: ${record.relPath}`;
      }
      attachmentStore.delete(record.relPath);
      attachmentReceipts.delete(token);
      return undefined as T;
    }
    case "check":
      // `@tauri-apps/plugin-updater`'s `check()` calls
      // `invoke("plugin:updater|check", ...)`; the "plugin:" prefix is
      // stripped above so it lands here. There's no real updater in the
      // browser mock, so degrade gracefully: falsy metadata makes `check()`
      // resolve to `null` (its documented "no update available" contract).
      console.info("[mock] check (updater) -> no update");
      return null as T;
    default:
      console.warn("[mock] unhandled invoke:", cmd, args);
      return undefined as T;
  }
}

export function convertFileSrc(filePath: string, _protocol?: string): string {
  // no asset:// scheme in a browser; just hand back the path (broken img is fine for debugging)
  return filePath;
}
