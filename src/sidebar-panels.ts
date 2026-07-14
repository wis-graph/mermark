// The left-sidebar panel registry (R9, _workspace/01_architecture.md). Same
// shape as shortcuts/registry.ts and markdown/live-preview/feature-registry.ts:
// a plain array + named functions, no reactive framework (cold-load
// constraint — CLAUDE.md). This is the ONE place "left sidebar panel" exists
// as a first-class concept: explorer/recent/outline register here alongside
// any future extension panel, so mutual exclusion, DOM mount order, top-strip
// attachment, and left-command-group rehoming apply uniformly instead of the
// three hardcoded main.ts call sites this replaces
// (_workspace/00_request.md's "half runtime" bug — a 4th registered panel
// used to render but never join mutual exclusion).
//
// SCOPE: this registry owns only the common contract {id, button, aside,
// close}. Panel-specific methods (jumpToRoot, refresh, refreshFavoriteStars,
// revealFavorites, resetToBaseDir, listener, ...) are NOT here — main.ts
// keeps wiring those directly from each panel's own return value. Rolling
// them into this registry would make it a God object that has to know every
// panel's private API (_workspace/00_request.md's explicit constraint).
//
// GROUP CONCEPT: exactly one group exists today ("left rail"). A second
// group (e.g. a right rail) is a hypothetical, not a real consumer — no
// `group` field on SidebarPanel until one actually shows up (YAGNI, same
// judgment plugin-system.md rev 2 made about its wrapping layer).

import { createSidebarTopStrip, rehomeLeftCommandGroup } from "./title-bar";

export interface SidebarPanel {
  /** NEVER-RENAME contract — same reason a ShortcutAction id never renames
   *  (shortcuts/registry.ts): future persisted state (e.g. "restore the last
   *  open panel") may key off this id. Built-in ids: "explorer" | "recent" |
   *  "outline". */
  id: string;
  /** The left-command-group toggle button for this panel. */
  button: HTMLButtonElement;
  /** The rail element. `hidden` is the open/closed SSOT (title-bar.ts's
   *  documented contract — the same source the CSS sibling rules key off). */
  aside: HTMLElement;
  /** Idempotent close. The mutual-exclusion coordinator calls this
   *  unconditionally on every panel but the one staying open. */
  close(): void;
}

interface InstallCtx {
  workspace: HTMLElement;
  bar: HTMLElement;
  group: HTMLElement;
  buttonAnchor: HTMLElement | null;
}

const panels: SidebarPanel[] = [];
let ctx: InstallCtx | null = null;
let observer: MutationObserver | null = null;

/** Fail fast on a duplicate panel id — a developer error in a single-user
 *  codebase, not a recoverable UI state (mirrors shortcuts/registry.ts's
 *  assertNewActionId — same shape, same reasoning). Pure query (raises
 *  instead of returning). */
function assertNewSidebarPanelId(id: string): void {
  if (panels.some((p) => p.id === id)) {
    throw new Error(`registerSidebarPanel: panel id "${id}" is already registered`);
  }
}

/** Seat one panel into the installed shell: prepend its aside (the sash's
 *  sibling-combinator CSS requires every rail aside to sit BEFORE the sash —
 *  main.ts's former comment on this), prepend its window-chrome strip,
 *  insert its button just before the anchor (openPath) so registration order
 *  becomes button order, and start observing its aside's `hidden` flips so a
 *  late-registered panel still participates in rehoming. Command (void). */
function mountSidebarPanel(p: SidebarPanel): void {
  const c = ctx!;
  c.workspace.prepend(p.aside);
  p.aside.prepend(createSidebarTopStrip());
  c.group.insertBefore(p.button, c.buttonAnchor);
  observer!.observe(p.aside, { attributes: true, attributeFilter: ["hidden"] });
}

/** Register a left-sidebar panel. Panels register in the order their button
 *  should appear (left→right, before openPath). If installSidebarPanels has
 *  already run, the panel is mounted immediately (an extension finishing
 *  init after boot, or a test); otherwise it just joins the array and
 *  installSidebarPanels mounts it later. Command (void).
 *
 *  No unregister: none of the three built-in panels support teardown
 *  (_workspace/00_request.md fact D — no removeEventListener/destroy
 *  anywhere in explorer/outline/recent-panel.ts). A registry-level
 *  unregister that only splices the array and leaves the DOM + observer
 *  subscription behind would be a lying API — unlike registerCommand/
 *  registerBlockFeature, which reverse real effects. Add it only once a
 *  panel actually grows a destroy(). */
export function registerSidebarPanel(p: SidebarPanel): void {
  assertNewSidebarPanelId(p.id);
  panels.push(p);
  if (ctx) mountSidebarPanel(p);
}

/** Registered panels, in registration order (= button order). Pure query. */
export function sidebarPanels(): readonly SidebarPanel[] {
  return panels;
}

/** The left rail shows at most one panel at a time — the only domain rule
 *  this registry enforces. Closes every registered panel except `keepId`;
 *  each close() is idempotent so an unconditional call is safe. Replaces
 *  main.ts's old 3-way union `closeOtherSidebars` — a 4th (extension) panel
 *  now participates automatically, in both directions (opening a built-in
 *  closes the extension, and vice versa, since both call this with their own
 *  id). Command (void). */
export function closeOtherSidebarPanels(keepId: string): void {
  for (const p of panels) if (p.id !== keepId) p.close();
}

/** Which registered panel's aside is currently open, if any — "at most one
 *  rail is open" read back from the `hidden` SSOT. Pure query. */
function visibleAside(): HTMLElement | null {
  return panels.find((p) => !p.aside.hidden)?.aside ?? null;
}

/** The window-chrome strip prepended into a rail aside, if it has one. Pure
 *  query. Moved from title-bar.ts (rev M6) — the rail set is now this
 *  registry's knowledge, not title-bar's. */
function railStrip(aside: HTMLElement | null): HTMLElement | null {
  return aside?.querySelector<HTMLElement>(":scope > .sidebar-top-strip") ?? null;
}

/** Boot-time install: mount every already-registered panel into the shell
 *  and arm the MutationObserver that keeps the left command group homed in
 *  whichever rail is open (title-bar.ts's rehomeLeftCommandGroup — the one
 *  domain rule for "which home wins" stays there, this only supplies the
 *  now-dynamic rail set). A panel registered AFTER this call is mounted by
 *  registerSidebarPanel and joins the SAME observer, so late/extension
 *  registration still rehomes correctly (the bug installLeftGroupRehoming's
 *  fixed `asides[]` array had). Second call is a developer error (throws) —
 *  same rationale as the duplicate-id guard. Command (void). */
export function installSidebarPanels(opts: InstallCtx): void {
  if (ctx) throw new Error("installSidebarPanels: already installed");
  ctx = opts;
  observer = new MutationObserver(() => rehomeLeftCommandGroup(opts.group, opts.bar, railStrip(visibleAside())));
  for (const p of panels) mountSidebarPanel(p);
  rehomeLeftCommandGroup(opts.group, opts.bar, railStrip(visibleAside())); // initial placement
}
