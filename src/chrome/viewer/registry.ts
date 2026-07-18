// The non-markdown-file VIEWER registry (R11, _workspace/01_r11.md). Same
// shape as sidebar/registry.ts, shortcuts/registry.ts, and
// markdown/live-preview/feature-registry.ts: a plain array + named functions,
// no reactive framework (cold-load constraint — CLAUDE.md).
//
// SCOPE: this registry is a PURE CATALOG (id/extensions/open) — it does not
// own the don't-stack overlay slot (main.ts's `openViewer`, unchanged, see
// design §5) and it does not own mutual exclusion with the left sidebar
// panels (that's sidebar/registry.ts's closeOtherSidebarPanels, a different
// concept entirely). Registering here only tells `viewerFor` which Viewer
// claims an extension; opening it and tearing down a previous one is the
// caller's job.

export interface ViewerHandle {
  /** Idempotent teardown — image-viewer.ts's existing ImageViewerHandle
   *  contract, generalized. Safe to call more than once. */
  close(): void;
  /** Run `cb` exactly once when this viewer closes — INCLUDING the closes the
   *  opener never initiates (Esc, the header's ✕). Without this the opener
   *  can only know about closes it called itself, so any chrome it changed on
   *  open (the footer breadcrumb, main.ts) would stay stuck at the viewer's
   *  state after the user Esc'd back to their document — the exact staleness
   *  reported 2026-07-19. Every viewer forwards this to its shell's
   *  `onTeardown`; it is REQUIRED (not optional) so a new viewer cannot
   *  silently reintroduce that gap. */
  onClose(cb: () => void): void;
}

export interface Viewer {
  /** NEVER-RENAME — same reason a ShortcutAction/SidebarPanel id never
   *  renames (shortcuts/registry.ts, sidebar/registry.ts): a future
   *  persisted state key ("restore the last open viewer") may key off this.
   *  Built-in: "image". Extension convention: "ext.<name>"
   *  (docs/design/plugin-system.md §7). */
  id: string;
  /** Extensions this viewer opens, already in the format `extensionOf`
   *  returns: lowercase, no leading dot (e.g. "xlsx", not "XLSX"/".xlsx"). */
  extensions: readonly string[];
  /** Human-readable name for panel UI (e.g. the viewer-toggles settings row).
   *  Unlike `id`, this is NOT persisted anywhere and may be freely renamed —
   *  no stored state ever keys off it. Optional so this stays a non-breaking
   *  addition for any existing Viewer literal; UI that needs a display name
   *  derives a fallback when it's absent (settings/panel/controls.ts's
   *  viewerDisplayName). */
  label?: string;
  /** Open `absPath` in this viewer and return a handle. Lifecycle (don't-stack
   *  single overlay slot) is the CALLER's job (main.ts), not this registry's —
   *  see design §5 (a registry that owned the slot would become the God
   *  object R9 explicitly avoided, sidebar/registry.ts:15-17). */
  open(absPath: string): ViewerHandle;
}

const viewers: Viewer[] = [];

/** Fail fast on a duplicate viewer id — a developer error in a single-user
 *  codebase, not a recoverable UI state (mirrors sidebar/registry.ts's
 *  assertNewSidebarPanelId / shortcuts/registry.ts's assertNewActionId —
 *  same shape, same reasoning). Pure query (raises instead of returning). */
function assertNewViewerId(id: string): void {
  if (viewers.some((v) => v.id === id)) {
    throw new Error(`registerViewer: viewer id "${id}" is already registered`);
  }
}

/** Fail fast on a malformed extension: uppercase, a leading dot, or empty all
 *  silently never match `viewerFor` (which only ever queries `extensionOf`'s
 *  output — lowercase, no dot). A viewer registered with "XLSX" would look
 *  correctly registered forever while every real xlsx file passes it by —
 *  exactly the class of bug this session's "test a guard both ways" lesson
 *  (_workspace/00_request.md) targets. Pure query (raises). */
function assertViewerExtensionFormat(ext: string): void {
  if (ext === "" || ext !== ext.toLowerCase() || ext.startsWith(".")) {
    throw new Error(`registerViewer: extension "${ext}" must be lowercase with no leading dot`);
  }
}

/** Register a viewer. Extensions are claimed first-registered-wins on a
 *  collision (viewerFor below) — the same semantics core.ts's block-feature
 *  dispatch uses for a shared node, not a throw: a built-in registered at
 *  boot naturally wins over anything an extension claims later. No
 *  `prepend`/priority option — no real consumer wants to override a built-in
 *  viewer today (YAGNI, same judgment R11's design made about unregister).
 *  Command (void). */
export function registerViewer(v: Viewer): void {
  assertNewViewerId(v.id);
  for (const ext of v.extensions) assertViewerExtensionFormat(ext);
  viewers.push(v);
}

/** The viewer that claims `ext` (already lowercased/dot-stripped by
 *  `extensionOf`), or null if none does. First-claim-wins over registration
 *  order — mirrors feature-registry.ts's block-feature dispatch semantics
 *  (design §2). Pure query. */
export function viewerFor(ext: string): Viewer | null {
  return viewers.find((v) => v.extensions.includes(ext)) ?? null;
}

/** Every registered viewer, in registration order. Pure query — a read of
 *  the catalog, the same kind of operation `viewerFor` already does, not a
 *  policy decision (design §5(a)): the settings panel uses this to enumerate
 *  one toggle row per viewer. Returns a live array reference is avoided —
 *  callers get a readonly view so they can't push onto the real catalog. */
export function listViewers(): readonly Viewer[] {
  return viewers;
}
