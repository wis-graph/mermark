// mermark's extension facade — the ONE module `src/extensions/**` (and any
// future personal extension code) is allowed to import from. Everything here
// is a raw re-export/re-value of an existing mermark type or function; there
// is NO wrapping layer (no MdNode/MdWidget/InlineApi adapters — that design
// was tried and dropped: mermark has exactly one consumer of this API, this
// codebase itself, so "insulate third parties from a future CM6 rip-out" buys
// nothing and the wrapping cost real expressive power — see
// docs/design/plugin-system.md rev 2 for the full argument).
//
// Contracts an extension must honor (violating these breaks user-visible
// state, not just style):
//
// 1. COMMAND ID NEVER RENAME. A ShortcutAction id registered via
//    registerCommand is the localStorage key user keybinding overrides are
//    stored under (shortcuts/app.ts's keybindingsSetting, `{ id: chord }`).
//    Renaming an id orphans any override a user saved for the old id — same
//    rule the built-in catalog follows (shortcuts/actions.ts:17).
// 2. BlockSpec.widget() MUST BE PURE (a thunk with no side effects). It may
//    be called again on every selection change even when nothing else about
//    the block changed (core.ts's buildDeco calls it per revealed spec) — a
//    widget constructor that does I/O or mutates outside state will run far
//    more often than "once per render".
// 3. CONCEAL CLASSIFICATION. A `Spec.conceal: true` decoration is a MARKER
//    the core reveal rule (core.ts's `revealed`) may drop when the cursor
//    touches its line in edit mode — use it for syntax you want to hide
//    while rendered and show while editing (`==`, `[[`, `]]`, fence lines).
//    `conceal: false` decorations (e.g. a `Decoration.mark` that just adds a
//    CSS class) are ALWAYS visible regardless of cursor position — use it for
//    styling that should never disappear. Getting this backwards either
//    permanently hides source text (readers can never edit it) or never
//    conceals a marker that should vanish on render.
// 4. SIDEBAR PANEL ID NEVER RENAME (R9, _workspace/01_architecture.md). Same
//    reasoning as #1 — a SidebarPanel.id may become the key future persisted
//    state (e.g. "restore the last open panel") is stored under.
// 5. A SIDEBAR PANEL MUST CALL closeOtherSidebarPanels(itsOwnId) FROM ITS OWN
//    OPEN PATH. The registry owns mutual exclusion (at most one left rail
//    panel open at a time) but cannot intercept `open()` — no common open()
//    exists across panels (each built-in panel's open is a private closure,
//    not part of the {id, button, aside, close} contract) — so an extension
//    panel is responsible for calling this itself when it opens, exactly the
//    way explorer/recent/outline's onOpen callbacks do (main.ts).
// 6. VIEWER ID NEVER RENAME (R11, _workspace/01_r11.md §2) — same reasoning
//    as #1/#4. ViewerHandle.close() MUST BE IDEMPOTENT (the shell/don't-stack
//    slot may call it more than once). Viewer.extensions entries MUST be
//    lowercase with no leading dot (registerViewer throws otherwise).
//
// CM6/Lezer packages are DELIBERATELY NOT re-exported here — an extension
// imports `@codemirror/view`'s Decoration/WidgetType and `@lezer/common`'s
// SyntaxNode directly from those npm packages. This facade fences mermark's
// OWN internal modules (so there is one blessed import path into mermark);
// it does not fence CM6 itself, which extensions are expected to depend on
// natively (rev 2 §2.3 — "CM6-native" is the whole point of skipping the
// wrapping layer).

export {
  registerInlineFeature,
  registerBlockFeature,
} from "../markdown/live-preview/feature-registry";
export type {
  InlineFeature,
  BlockFeature,
  Spec,
  BlockSpec,
  InlineCtx,
  BlockCtx,
} from "../markdown/live-preview/core";
export { hide, fencedInfo } from "../markdown/live-preview/core";

export { registerCommand } from "../shortcuts/registry";
export type { ShortcutAction } from "../shortcuts/actions";

export { registerSetting } from "../settings/registry";
export type { Setting, SettingDef } from "../settings/store";

export { registerSidebarPanel, closeOtherSidebarPanels } from "../sidebar/registry";
export type { SidebarPanel } from "../sidebar/registry";
export { renderSidebarButton } from "../sidebar/toggle";

// R11 (_workspace/01_r11.md §2/§6): the non-markdown-file viewer registry +
// the shared overlay shell + the local-file-bytes fetch rule. `viewerFor` is
// deliberately NOT re-exported — only main.ts (the composition root) queries
// "which viewer opens this file"; an extension registers its own viewer and
// has no legitimate reason to query another's.
export { registerViewer, type Viewer, type ViewerHandle } from "../chrome/viewer/registry";
export { openViewerShell, type ViewerShell } from "../chrome/viewer/shell";
export { readLocalFileBytes } from "../chrome/viewer/file-bytes";
