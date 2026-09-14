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
    // Dev hook (set below, right after `invoke` is defined): lets an outside
    // driver (Playwright/CDP script) call the mock's REAL `invoke` — the
    // exact module-scoped `store` the running app itself reads/writes —
    // instead of doing its own `import("/src/mocks/tauri-core.ts")`. A
    // dynamic import by URL is only guaranteed to hit the same module
    // instance the app is using when Vite has served that exact URL
    // (querystring included) to both; any HMR invalidation since boot makes
    // Vite serve the app a fresh `?t=...`-versioned copy with its OWN
    // `store` Map, so a script's unversioned re-import silently talks to a
    // disconnected copy (writes vanish from its own reads) — that's what
    // made the workspace-smoke autosave/appCloseEquivalent scenarios look
    // broken even though the app really did save. window.__mockInvoke sidesteps
    // the whole versioning question by reusing whichever instance actually
    // booted the page.
    __mockInvoke?: typeof invoke;
    // Same reasoning as __mockInvoke: the live watch session, read off
    // whichever module instance actually booted the page.
    __mockCurrentWatchSession?: typeof currentMockWatchSession;
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

/** C2 regression guard (final review's mock-tightening requirement): the
 *  real backend's `watch_file` (`watcher.rs`'s `set_watch`) calls
 *  `notify::Watcher::watch(Path::new(path))` directly — for a RELATIVE path
 *  (exactly the shape a remote vault's vault-relative document name takes,
 *  e.g. `"노트.md"`) that resolves against the process's CWD, which almost
 *  always has no such file, so the real call fails with `PathNotFound`. This
 *  mock used to accept ANY string unconditionally, including a relative one
 *  — which is exactly what let a remote document's open silently succeed at
 *  arming a LOCAL watch in every test run against this mock, while the real
 *  app either failed outright or (worse) watched an unrelated same-named
 *  local file. `shouldWatchDocument`'s gate in file-watch.ts is supposed to
 *  prevent `watch_file` from ever being called for a remote document at all
 *  — this makes a regression of that gate fail loudly here too, instead of
 *  this mock quietly "succeeding" against nothing. */
function beginMockWatch(path: string): MockWatchSession {
  if (!path.startsWith("/")) throw `watch ${path}: No such file or directory (os error 2)`;
  const session = { path, generation: String(++mockWatcherGeneration) };
  mockWatchedPath = path;
  mockWatchSession = session;
  return session;
}

function clearMockWatch(): void {
  mockWatchedPath = null;
  mockWatchSession = null;
}

/** The watch session currently armed (path + backend-assigned generation), or
 *  null if nothing is watched. Exported read-only accessor so smoke/golden
 *  scripts can build a correctly-shaped `file-unavailable`/`file-changed`
 *  event payload (createWatcherHandoff.accepts() in file-watch.ts rejects any
 *  event whose `path`/`generation` don't match the live session — a payload
 *  missing either field is silently ignored, not an error, which is easy to
 *  miss from outside). */
export function currentMockWatchSession(): { readonly path: string; readonly generation: string } | null {
  return mockWatchSession;
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
// Explicit test hook for the `remote_*` commands' three failure classes
// (REMOTE:AuthExpired / REMOTE:SharingOff / REMOTE:Unreachable — see
// remote_client.rs's `classify`). Pair with a host literally typed as
// "mock-error:auth-expired" etc. in the remote-vault UI to force that error
// path in the browser mock; any other host succeeds normally. Deliberately a
// magic *host value*, not a magic branch buried in each case, so it's
// discoverable from the call site instead of ambient.
function remoteMockError(host: string): string | null {
  // T2 (0.17.1): mirrors Rust `base_url`'s guards (remote_client.rs:46-70)
  // verbatim — same three rejections, in the same order Rust checks them,
  // so the mock can't be more lenient than the real backend on ANY of
  // them (QA finding: the empty-host and scheme/path checks were missing
  // here even though the non-ASCII one was covered — a pre-flight-bypassing
  // test, or a future remote_* caller that skips hostFieldProblem, would
  // have gotten a false "passes in the mock" while the real app 400s).
  if (host === "") {
    return "호스트가 비어 있습니다";
  }
  if (!host.startsWith("ssh://") && (host.includes("://") || host.includes("/"))) {
    return `호스트에는 이름과 포트만 적습니다: ${host}`;
  }
  if (!host.startsWith("ssh://") && !/^[\x00-\x7f]*$/.test(host)) {
    return `호스트 이름에는 영문·숫자·점·하이픈만 쓸 수 있습니다: ${host}`;
  }
  const m = /^mock-error:(auth-expired|sharing-off|unreachable)$/.exec(host);
  if (!m) return null;
  const CODES: Record<string, string> = {
    "auth-expired": "REMOTE:AuthExpired",
    "sharing-off": "REMOTE:SharingOff",
    unreachable: "REMOTE:Unreachable",
  };
  return CODES[m[1]] ?? null;
}

/** C1/N4 regression guard, mirrored in this mock (final review's
 *  mock-tightening requirement, tightened further by the N4 re-review
 *  finding that this only ever caught a leading `/`): the real host's
 *  `safe_path` (remote_host.rs) treats ONLY the empty string as "the vault
 *  root" (`resolve_within`'s own carve-out) and otherwise runs two gates on
 *  every non-empty path — `resolve_within`'s lexical gate, which rejects
 *  any path component that is not `Component::Normal` (an absolute leading
 *  `/`, a `..`, or a leading `./`), and `safe_path`'s hidden/artifact gate
 *  (`has_a_hidden_or_artifact_component`, reusing `is_hidden_entry`/
 *  `is_mermark_artifact` — same policy the local `list_dir` mock above
 *  already applies via `e.name.startsWith(".")`). Both fold into
 *  `REMOTE:SharingOff` on the wire (a rejected path 404s, which
 *  `remote_client.rs`'s `classify` maps to `SharingOff`). One named function
 *  every `remote_*` handler below calls FIRST on its vault-relative
 *  `path`/`baseDir`/`dir` argument, the same order `safe_path` runs in — so
 *  a future case added here reuses this rule instead of re-deriving (and
 *  drifting from) it. */
function refusesEscapingRemotePath(path: unknown): void {
  if (typeof path !== "string" || path === "") return; // "" = vault root, safe_path's carve-out
  if (path.startsWith("/")) throw "REMOTE:SharingOff"; // RootDir component
  const segments = path.split("/").filter((s) => s.length > 0);
  segments.forEach((segment, i) => {
    if (segment === "..") throw "REMOTE:SharingOff"; // ParentDir component
    if (i === 0 && segment === ".") throw "REMOTE:SharingOff"; // leading CurDir component
    if (segment !== "." && (segment.startsWith(".") || segment.includes(".mermark-tmp.") || segment.includes(".mermark-recovered"))) {
      throw "REMOTE:SharingOff"; // hidden/artifact gate
    }
  });
}

/** N5 regression guard: mirrors `ensure_tunnel_serves` (remote_client.rs) —
 *  the cross-host token-leak guard checked before any `remote_*` request is
 *  even sent. For an `ssh://` host, every wire command shares the one local
 *  tunnel port (`remote_ssh.rs`), so a client that skipped
 *  `ensureSshTunnel()` (or whose tunnel has since been replaced by a
 *  different host, or reaped) must be refused here with the same
 *  `SSH_TUNNEL_MISMATCH:` prefix `file-host.ts`'s `isTunnelMismatch` matches
 *  on — otherwise this mock would silently let a bypass reach `dev:browser`
 *  that the real backend refuses. A non-`ssh://` host is untunneled
 *  (Tailscale-style direct reachability) and never gated here, same as the
 *  real `ensure_tunnel_serves`'s early return. */
function refusesStaleSshTunnel(host: string): void {
  if (!host.startsWith("ssh://")) return;
  if (sshTunnelHost !== host) {
    throw `SSH_TUNNEL_MISMATCH: ${host}에 대한 SSH 터널이 더 이상 유효하지 않습니다. 다시 연결하세요.`;
  }
}

// ── remote_read_asset mock (T6, 0.18.0) ─────────────────────────────────────
/** T6 regression guard, mirroring the real host's 20 MiB `MAX_ASSET_BYTES`
 *  cap (remote_host.rs, design §4.5): the mock has no real oversized fixture
 *  to serve, so a path whose basename starts with "too-large" is a
 *  discoverable magic value (same idiom `remoteMockError`'s "mock-error:"
 *  host prefix already uses) that forces the SAME `REMOTE_ASSET_TOO_LARGE:`
 *  prefix the real backend returns for a 413 — the exact QA finding this
 *  round fixes ("413 reported as Unreachable") must stay caught by a mock
 *  that can actually produce a 413-shaped rejection. */
function refusesRemoteAssetOverCap(path: string): void {
  const base = path.split("/").pop() ?? path;
  if (base.startsWith("too-large")) throw `REMOTE_ASSET_TOO_LARGE: ${path}`;
}

/** Real fixture files this mock can already serve as LOCAL bytes (Vite's
 *  browser-mode publicDir, mock-assets/mock/vault/*) — reused here so a
 *  remote-vault open of the SAME basename renders the SAME real content a
 *  local open would (a golden-master scenario can assert on actual
 *  rendered rows/pages, not just "did not throw"), instead of every remote
 *  asset being opaque placeholder bytes. Any other path falls back to
 *  deterministic placeholder bytes — real content is a nice-to-have here,
 *  never a requirement (no test asserts byte VALUES for those). */
const REMOTE_ASSET_LOCAL_FIXTURES = new Set(["report.xlsx", "guide.pdf", "sample.pdf", "sample.docx", "sample.html", "sample-asset.png"]);

async function mockRemoteAssetBytes(path: string): Promise<Uint8Array> {
  const base = path.split("/").pop() ?? path;
  if (REMOTE_ASSET_LOCAL_FIXTURES.has(base)) {
    try {
      const res = await fetch(`/mock/vault/${base}`);
      if (res.ok) return new Uint8Array(await res.arrayBuffer());
    } catch {
      // fall through to the placeholder below — a fetch failure here is a
      // dev:browser environment quirk, not something remote_read_asset's
      // OWN contract should ever surface as a rejection.
    }
  }
  return new TextEncoder().encode(`mock remote asset: ${path}`);
}

// ── remote_ssh_* mock state (client-side SSH tunnel fallback — task 12) ────
// Mirrors `SshTunnels` (src-tauri/src/remote_ssh.rs): at most one tunneled
// host at a time, reused when the same host connects again, refused when a
// different host asks while one is active. The browser mock has no real
// port or subprocess to manage — it just tracks which host (if any) is
// "tunneled" so the same port-collision guard is observable in dev:browser.
let sshTunnelHost: string | null = null;

// ── remote_share_* mock state (the HOST side — task 9b) ─────────────────────
// Mirrors `RemoteShareState`/`HostState` (src-tauri/src/remote_share.rs,
// remote_host.rs): in-memory only, starts off, remembers the last-configured
// bind_mode/port/vaults even after a stop (checked against task-9a-report.md
// §2: "서버가 꺼져 있어도 유지된다" — the real backend does NOT clear armed
// vaults on stop, only the axum server task).
interface MockDevice { id: string; label: string; pairedAtMs: number }
const hostShare: {
  running: boolean;
  bindMode: "tailscale" | "localhost-only";
  port: number;
  vaults: Array<{ id: string; display_name: string }>;
  devices: MockDevice[];
  codeIssuedAtMs: number | null;
} = {
  running: false,
  bindMode: "tailscale",
  port: 8787,
  vaults: [],
  // Pre-seeded so the "연결 해제" affordance is exercisable in dev:browser
  // without a second real device to pair from — same "exercise every feature
  // by default" philosophy as SAMPLE's kitchen-sink doc above.
  devices: [{ id: "dev-demo", label: "맥북 프로 (데모)", pairedAtMs: Date.now() - 86_400_000 }],
  codeIssuedAtMs: null,
};

/** Explicit test hook for `remote_share_start`'s failure paths, mirroring
 *  `remoteMockError`'s magic-VALUE convention above (not a magic branch
 *  buried in the case body): a vault whose `root` literally equals one of
 *  these strings makes the mocked start fail the way the real backend does —
 *  `"mock-error:tailscale-unavailable"` mirrors `resolve_bind_ip`'s Err when
 *  the `tailscale` CLI can't resolve an IP (still worth exercising even
 *  though the panel no longer branches on this message — 9b fix round 1
 *  finding 3 replaced that string-matching with a proactive
 *  `remote_tailscale_available` probe; this just confirms a genuine start
 *  failure is still shown verbatim, error text untouched); `"mock-error:
 *  missing-root"` mirrors `arm_vaults`'s pre-flight `.is_dir()` guard
 *  (task-9a-report.md Finding 2 — names the vault). */
function hostShareMockError(vaults: readonly { id: string; display_name: string; root: string }[]): string | null {
  const missing = vaults.find((v) => v.root === "mock-error:missing-root");
  if (missing) return `"${missing.display_name}" 볼트의 경로를 찾을 수 없습니다: ${missing.root}`;
  if (vaults.some((v) => v.root === "mock-error:tailscale-unavailable")) return "Tailscale 주소를 찾을 수 없습니다 (tailscale ip -4 실패)";
  return null;
}

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
      // Tauri snake→camel mapping: { baseDir, name, maxDepth }. `maxDepth` is
      // accepted but ignored here (the mock has no tree to bound a walk over) —
      // the real backend clamps it to `MAX_IMAGE_SCAN_DEPTH` (12).
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
    case "arm_remote_html_view_root": {
      // T7 (0.18.0): mirrors the real
      // `arm_remote_html_view_root(host, vault, dir) -> Result<String, String>`
      // (design §5.5) — the remote counterpart of `arm_html_view_root` just
      // above, same rationale for a FIXED token (determinism for spy
      // assertions, no real `htmlview://` handler in a plain browser).
      // Distinct token string so a test can tell "which arm call produced
      // this iframe.src" apart without inspecting the invoke args again.
      const host = String(a.host ?? "");
      const err = remoteMockError(host);
      if (err) throw err;
      refusesStaleSshTunnel(host);
      refusesEscapingRemotePath(a.dir);
      const token = "mock-remote-view-token";
      console.info("[mock] arm_remote_html_view_root", host, a.vault, a.dir, "->", token);
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
    case "canonicalize_path": {
      const raw = String(a.path ?? "");
      // Mirrors the real backend's `expand_home` special-casing a bare `~`
      // as `$HOME` (commands.rs) before canonicalizing — the browser has no
      // real home directory, so it stands in with the mock's one real root,
      // matching what a fresh reader would already expect to land on
      // (00_request.md #2: clicking the Global Vault jumps to "home").
      // Anything else falls through to the plain textual normalize as before.
      if (raw === "~") return "/mock/vault" as T;
      return normalizeMockPath(raw) as T;
    }
    case "open_path": {
      // Mirrors the real `open_path(path) -> Result<(), String>`: spawns the
      // file in a brand-new window. Only the EXPLICIT new-window gesture still
      // reaches this command — explorer/search ⌘/Ctrl+click and ⌘+Enter
      // (single-window-opening plan). Wikilink clicks and standard local
      // Markdown links no longer call this: they route through
      // `requestDocumentOpen`/`openDocumentSafely` (main.ts) into the CURRENT
      // window's safe-open transaction instead (Todo 3) — see that seam's own
      // mock entries below, not this one. The browser mock has no real
      // webview windows to spawn, so it falls back to a new browser tab
      // carrying the same `?file=` query the real backend's window URL uses —
      // close enough to exercise the flow under CDP/DevTools debugging.
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
      // Result<AttachmentImportOutcome, String>` (post `vault:` withdrawal —
      // see `attach_outcome_from` in attachment_import.rs). The browser mock
      // has no native file dialog, so `window.__mockAttachPick` stands in for
      // the user's picker choice: `null`/unset -> cancelled (no import code
      // reached, matching the real command's "None -> Ok{cancelled}" shape),
      // a string -> the "picked" source path (never actually read — the mock
      // has no real bytes to copy, except for the alreadyInVault check below,
      // which only needs the string itself).
      //
      // Inside-vault check: if the picked path already sits under
      // `vault_root` (a plain string-prefix approximation of the real
      // backend's `fs::canonicalize` + prefix check — the mock has no real
      // filesystem to canonicalize), the outcome is `alreadyInVault`: no
      // copy, no receipt, matching `attach_outcome_from`'s no-op-on-in-vault
      // contract. Otherwise the picked source is copied in, and candidate
      // naming reproduces the real `attachment_file_name` decision: n=0 keeps
      // the basename, n>=1 inserts `-{n}` before the extension, retried only
      // while the slot is taken — same no-clobber contract, just against
      // `attachmentStore` instead of a real `.attachments` directory.
      const pick = typeof window.__mockAttachPick === "function" ? window.__mockAttachPick() : (window.__mockAttachPick ?? null);
      console.info("[mock] import_vault_attachment", a.vaultRoot, "-> picked", pick);
      if (pick === null || pick === undefined) return { status: "cancelled" } as T;
      const picked = String(pick);
      const name = picked.split(/[/\\]/).pop() ?? picked;
      const vaultRoot = String(a.vaultRoot ?? "");
      if (vaultRoot) {
        const rootPrefix = vaultRoot.endsWith("/") ? vaultRoot : `${vaultRoot}/`;
        if (picked === vaultRoot || picked.startsWith(rootPrefix)) {
          console.info("[mock] import_vault_attachment -> alreadyInVault", name);
          return { status: "alreadyInVault", fileName: name } as T;
        }
      }
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
    case "remote_pair": {
      // Mirrors the real `remote_pair(host, code, label) -> Result<(), String>`:
      // exchanges a pairing code for a device token, remembered server-side —
      // the token never crosses back to the frontend (remote_client.rs's doc
      // comment), so success returns nothing.
      const host = String(a.host ?? "");
      const err = remoteMockError(host);
      if (err) throw err;
      console.info("[mock] remote_pair", host, a.code, a.label);
      return undefined as T;
    }
    case "remote_vaults": {
      // Mirrors the real `remote_vaults(host) -> Result<Vec<RemoteVault>, String>`.
      // Checked against `RemoteVault` in src-tauri/src/remote_client.rs: no
      // `rename_all`, so serde emits the Rust field names verbatim —
      // `display_name` stays snake_case, not `displayName`.
      const host = String(a.host ?? "");
      const err = remoteMockError(host);
      if (err) throw err;
      console.info("[mock] remote_vaults", host);
      return [{ id: "rv-demo", display_name: "원격 데모 볼트" }] as T;
    }
    case "remote_list_dir": {
      // Mirrors `remote_list_dir(host, vault, path, show_hidden) ->
      // Result<Vec<DirEntry>, String>`. Checked against `DirEntry` in
      // commands.rs (`is_dir` snake_case, same as the local `list_dir` mock
      // above) and against remote_host.rs's `list_dir_handler`, which rewrites
      // every entry's `path` to be **vault-relative** before it reaches the
      // client (the host never leaks its own absolute filesystem paths) — so
      // unlike the local TREE fixture, these paths carry no vault-root prefix.
      const host = String(a.host ?? "");
      const err = remoteMockError(host);
      if (err) throw err;
      refusesStaleSshTunnel(host);
      refusesEscapingRemotePath(a.path);
      console.info("[mock] remote_list_dir", host, a.vault, a.path, "showHidden", a.showHidden);
      return [{ name: "원격노트.md", path: "원격노트.md", is_dir: false }] as T;
    }
    case "remote_list_files_recursive": {
      // Mirrors `remote_list_files_recursive(host, vault, path, show_hidden) ->
      // Result<ScanResult, String>`. Checked against `FileHit` (commands.rs):
      // three fields — `name`, `path`, `rel_path` — not two; `path` is
      // rewritten vault-relative by `list_files_recursive_handler`
      // (remote_host.rs) the same way `list_dir`'s is, so it equals `rel_path`
      // here (no absolute vault-root prefix exists on the wire).
      const host = String(a.host ?? "");
      const err = remoteMockError(host);
      if (err) throw err;
      refusesStaleSshTunnel(host);
      refusesEscapingRemotePath(a.path);
      console.info("[mock] remote_list_files_recursive", host, a.vault, a.path, "showHidden", a.showHidden);
      return {
        files: [{ name: "원격노트.md", path: "원격노트.md", rel_path: "원격노트.md" }],
        truncated: false,
      } as T;
    }
    case "remote_read_file": {
      // Mirrors `remote_read_file(host, vault, path) -> Result<FileContent, String>`.
      // Checked against `FileContent` (commands.rs): `{ text, mtime }`, same
      // shape as the local `read_file` mock.
      const host = String(a.host ?? "");
      const err = remoteMockError(host);
      if (err) throw err;
      refusesStaleSshTunnel(host);
      refusesEscapingRemotePath(a.path);
      console.info("[mock] remote_read_file", host, a.vault, a.path);
      return { text: "# 원격 데모\n\n브라우저 mock이 만든 원격 문서입니다.", mtime: 1 } as T;
    }
    case "remote_read_image": {
      // Mirrors `remote_read_image(host, vault, path) -> Result<String, String>`:
      // checked against remote_client.rs's `data_url` — returns a
      // `data:<mime>;base64,...` string directly, not a path (there is no
      // remote filesystem for `convertFileSrc` to address).
      const host = String(a.host ?? "");
      const err = remoteMockError(host);
      if (err) throw err;
      refusesStaleSshTunnel(host);
      refusesEscapingRemotePath(a.path);
      console.info("[mock] remote_read_image", host, a.vault, a.path);
      return "data:image/png;base64,iVBORw0KGgo=" as T;
    }
    case "remote_read_asset": {
      // Mirrors `remote_read_asset(host, vault, path) -> Result<tauri::ipc::Response, String>`
      // (design §4.5/§8-B): the JS side of a `tauri::ipc::Response` is an
      // `ArrayBuffer`, so this mock hands one back too — the same shape
      // `readRemoteFileBytes`'s `toArrayBuffer` normalizer already accepts,
      // so a browser-mode caller exercises the exact code path a real
      // WKWebView would. `refusesRemoteAssetOverCap` fires FIRST (mirrors
      // the real backend intercepting 413 before `send_authorized` — design
      // §4.5) so the mock can't be more lenient than the real host on the
      // one failure class this round's own QA finding was about (413 being
      // reported as "연결 안 됨").
      const host = String(a.host ?? "");
      const err = remoteMockError(host);
      if (err) throw err;
      refusesStaleSshTunnel(host);
      refusesEscapingRemotePath(a.path);
      refusesRemoteAssetOverCap(String(a.path ?? ""));
      console.info("[mock] remote_read_asset", host, a.vault, a.path);
      const bytes = await mockRemoteAssetBytes(String(a.path ?? ""));
      return bytes.buffer as T;
    }
    case "remote_resolve_image": {
      // Mirrors `remote_resolve_image(host, vault, path, name, max_depth) ->
      // Result<Option<String>, String>` (Tauri maps `max_depth` to `maxDepth`
      // on the JS side, same snake→camel rule as the local `resolve_image`
      // mock's `maxDepth`). Checked against remote_host.rs's
      // `resolve_image_handler`, which rewrites a hit to vault-relative before
      // sending — this mock always misses (`null`), deterministic and cheap
      // since the browser has no remote tree to scan.
      const host = String(a.host ?? "");
      const err = remoteMockError(host);
      if (err) throw err;
      refusesStaleSshTunnel(host);
      refusesEscapingRemotePath(a.path);
      console.info("[mock] remote_resolve_image", host, a.vault, a.path, a.name, a.maxDepth);
      return null as T;
    }
    case "remote_list_link_targets": {
      // Mirrors `remote_list_link_targets(host, vault, path) ->
      // Result<Vec<LinkTarget>, String>`. Checked against `LinkTarget`
      // (commands.rs): `{ name, rel, kind }`, same shape as the local
      // `list_link_targets` mock. Empty here — the remote `[[` picker isn't
      // exercised by the SAMPLE doc, and an empty list is a valid response.
      const host = String(a.host ?? "");
      const err = remoteMockError(host);
      if (err) throw err;
      refusesStaleSshTunnel(host);
      refusesEscapingRemotePath(a.path);
      console.info("[mock] remote_list_link_targets", host, a.vault, a.path);
      return [] as T;
    }
    case "remote_ssh_connect": {
      // Mirrors `remote_ssh_connect(host) -> Result<(), String>`
      // (remote_ssh.rs): rejects a non-`ssh://` host the same way the real
      // `tunnel_args` does, reuses an already-open tunnel to the same host
      // (idempotent — no second spawn), and refuses a second host while one
      // is active with the exact `SSH_TUNNEL_BUSY:` prefix the real
      // `connect_with` returns (via `decide_connect`'s `Busy` case).
      const host = String(a.host ?? "");
      if (!host.startsWith("ssh://")) throw "ssh:// 호스트가 아닙니다";
      if (sshTunnelHost !== null && sshTunnelHost !== host) {
        throw `SSH_TUNNEL_BUSY: 이미 다른 호스트(${sshTunnelHost})로 SSH 터널이 연결되어 있습니다. 먼저 연결을 해제하세요.`;
      }
      sshTunnelHost = host;
      console.info("[mock] remote_ssh_connect", host);
      return undefined as T;
    }
    case "remote_ssh_disconnect": {
      // Mirrors `remote_ssh_disconnect(host) -> Result<(), String>`: a no-op
      // when nothing (or a different host) is connected, same "off toggle
      // never fails just because it's already off" idiom as
      // remote_share_stop's mock below.
      const host = String(a.host ?? "");
      if (sshTunnelHost === host) sshTunnelHost = null;
      console.info("[mock] remote_ssh_disconnect", host);
      return undefined as T;
    }
    case "remote_share_status": {
      // Mirrors `remote_share_status() -> ShareStatus` (remote_share.rs, no
      // args). `bind_mode`/`port`/`vaults` are the "last configured" values
      // and stay populated even while `running` is false, same as the real
      // HostState (task-9a-report.md §2) — this mock never clears them on stop.
      console.info("[mock] remote_share_status", hostShare.running);
      return {
        running: hostShare.running,
        bind_mode: hostShare.bindMode,
        port: hostShare.port,
        vaults: hostShare.vaults,
        devices: hostShare.devices.map((d) => ({ id: d.id, label: d.label, paired_at_ms: d.pairedAtMs })),
      } as T;
    }
    case "remote_share_start": {
      // Mirrors `remote_share_start(bind_mode, port, vaults) ->
      // Result<(), String>`. Checked against `VaultToArm` (remote_share.rs):
      // no `rename_all`, so each element's JSON key is `display_name`
      // (snake_case), not `displayName` — same trap the remote_vaults mock's
      // comment above already documents for `RemoteVault`.
      const bindMode = String(a.bindMode ?? "tailscale") as "tailscale" | "localhost-only";
      const port = Number(a.port ?? 8787);
      const vaults = (a.vaults ?? []) as Array<{ id: string; display_name: string; root: string }>;
      // Wording pinned to `share_start`'s exact string (remote_share.rs:290)
      // — fix round 1 flagged that a paraphrase here quietly drifts from
      // what the real backend says.
      if (vaults.length === 0) throw "공유할 볼트를 하나 이상 선택하세요";
      const err = hostShareMockError(vaults);
      if (err) throw err;
      // stop→start always (task-9a-report.md: "재시작은 항상 stop→start"),
      // and a fresh start invalidates any outstanding pairing code
      // (PairingState::unarmed() on restart).
      hostShare.running = true;
      hostShare.bindMode = bindMode;
      hostShare.port = port;
      hostShare.vaults = vaults.map((v) => ({ id: v.id, display_name: v.display_name }));
      hostShare.codeIssuedAtMs = null;
      console.info("[mock] remote_share_start", bindMode, port, vaults.length, "vaults");
      return undefined as T;
    }
    case "remote_share_stop": {
      // Mirrors `remote_share_stop() -> Result<(), String>`. bind_mode/port/
      // vaults are left as-is (last configured) — only `running` flips, same
      // as remote_share_status's contract above.
      hostShare.running = false;
      console.info("[mock] remote_share_stop");
      return undefined as T;
    }
    case "remote_issue_code": {
      // Mirrors `remote_issue_code() -> Result<IssuedCode, String>`. The real
      // backend refuses when no server is running (a code would have no
      // `/pair` to redeem against) — same refusal here.
      if (!hostShare.running) throw "공유가 꺼져 있어 페어링 코드를 발급할 수 없습니다";
      hostShare.codeIssuedAtMs = Date.now();
      console.info("[mock] remote_issue_code");
      return { code: "123456", issued_at_ms: hostShare.codeIssuedAtMs } as T;
    }
    case "remote_revoke_device": {
      // Mirrors `remote_revoke_device(id) -> Result<bool, String>` — id, never
      // a token (remote_share.rs's DeviceInfo never carries one either).
      const id = String(a.id ?? "");
      const before = hostShare.devices.length;
      hostShare.devices = hostShare.devices.filter((d) => d.id !== id);
      const revoked = hostShare.devices.length < before;
      console.info("[mock] remote_revoke_device", id, revoked);
      return revoked as T;
    }
    case "remote_tailscale_available": {
      // Mirrors `remote_tailscale_available() -> bool` (9b fix round 1,
      // finding 3 — a proactive probe, no args). dev:browser has no real
      // Tailscale to shell out to, so this hardcodes the common-case answer
      // (`true`) rather than fabricating a fake detection signal; flip this
      // literal locally if you need to exercise the "감지되지 않음" path.
      console.info("[mock] remote_tailscale_available -> true");
      return true as T;
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

window.__mockInvoke = invoke;
window.__mockCurrentWatchSession = currentMockWatchSession;

export function convertFileSrc(filePath: string, _protocol?: string): string {
  // no asset:// scheme in a browser; just hand back the path (broken img is fine for debugging)
  return filePath;
}
