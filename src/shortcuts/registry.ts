// The keyboard-shortcut dispatcher: the single place app chrome chords are
// resolved and fired. One global capture-phase keydown listener (installed
// once) reads the event into a canonical chord (keys.ts), looks up the bound
// action id, and runs its registered handler — replacing the scattered ad-hoc
// window keydown listeners the app used to carry.
//
// SSOT: effective bindings = user overrides (keybindingsSetting) layered over
// each action's default (actions.ts). Overrides flow in through ONE subscription
// (bindKeybindings); nothing hand-fans the binding map. Handlers are injected at
// boot (registerHandler) so this module stays free of main's boot graph.

import { eventToChord } from "./keys";
import { SHORTCUT_ACTIONS, type ShortcutAction } from "./actions";
import type { Setting } from "../settings/store";

type Handler = () => void;

// id → handler, injected at boot. A chord with no registered handler is inert
// (matched but does nothing) — safe during partial wiring.
const handlers = new Map<string, Handler>();
// The live user overrides ({ id: chord }); replaced wholesale by the setting
// subscription. Empty until bindKeybindings runs, so effectiveBinding falls back
// to defaults from the first call.
let overrides: Record<string, string> = {};
// chord → id reverse map, rebuilt whenever overrides change (single sink).
let lookup = new Map<string, string>();
let unbind: (() => void) | null = null;
let installed = false;
// While a settings capture is reading the next keypress, the global dispatcher
// stands down so the chord being assigned doesn't also fire its current action.
let suppressed = false;

// Runtime-registered actions (registerCommand), appended after the shipped
// catalog — extensions get real chords/handlers instead of the "half runtime"
// state where a handler could be registered for an id the catalog never knew,
// so it was matched by nothing.
const runtimeActions: ShortcutAction[] = [];

/** The full action catalog every lookup/UI iteration should use: the shipped
 *  const catalog (actions.ts) plus whatever registerCommand has added at
 *  runtime, in registration order (shipped first — insertion order ===
 *  settings-UI row order). The SINGLE query every SHORTCUT_ACTIONS-shaped
 *  iteration goes through, so a runtime action is indistinguishable from a
 *  shipped one everywhere lookups happen. Pure query. */
export function allActions(): readonly ShortcutAction[] {
  return [...SHORTCUT_ACTIONS, ...runtimeActions];
}

/** Bind an action id to the function that performs it. Boot calls this once per
 *  action; late/re-registration just replaces the handler. Command (void). */
export function registerHandler(id: string, handler: Handler): void {
  handlers.set(id, handler);
}

/** The effective chord for an action: the user override if present, else the
 *  shipped default (or null if unbound). The override-beats-default rule in one
 *  named place. Pure query. */
export function effectiveBinding(id: string): string | null {
  const o = overrides[id];
  if (o != null) return o;
  const action = allActions().find((a) => a.id === id);
  return action ? action.defaultBinding : null;
}

/** The action id already bound to `chord` (ignoring `exceptId`, the row being
 *  edited), or null if free. Compares against effective bindings so a would-be
 *  duplicate is rejected before it shadows another command. Pure query. */
export function findConflict(chord: string, exceptId?: string): string | null {
  for (const a of allActions()) {
    if (a.id === exceptId) continue;
    if (effectiveBinding(a.id) === chord) return a.id;
  }
  return null;
}

/** Rebuild the chord → id reverse map from the current effective bindings.
 *  Command (void). Called on every override change so lookup never drifts from
 *  the SSOT. A later action wins a duplicate chord, but the UI's conflict guard
 *  prevents duplicates from being stored. */
function rebuildLookup(): void {
  lookup = new Map();
  for (const a of allActions()) {
    const b = effectiveBinding(a.id);
    if (b) lookup.set(b, a.id);
  }
}

/** Fail fast on a duplicate action id (shipped or runtime) — this is a
 *  developer error in a single-user codebase, not a recoverable UI state, so
 *  it throws rather than silently overwriting a catalog entry. Pure query
 *  (raises instead of returning, but reads no external state and performs no
 *  write — named separately from registerCommand so the guard is one thing). */
function assertNewActionId(id: string): void {
  if (allActions().some((a) => a.id === id)) {
    throw new Error(`registerCommand: action id "${id}" is already registered`);
  }
}

/** Demote a new action's shipped default to null (+ warn) when it collides
 *  with an existing effective binding. WHY this exists: rebuildLookup's "a
 *  later action wins a duplicate chord" rule (see above) means a runtime
 *  registration with a colliding default would otherwise silently steal a
 *  built-in chord — the settings UI's conflict guard only runs when a user
 *  types a chord into the capture control, not on this programmatic path.
 *  Pure query: returns a (possibly modified) copy, does not mutate `action`. */
function demoteConflictingDefault(action: ShortcutAction): ShortcutAction {
  if (action.defaultBinding == null) return action;
  const conflict = findConflict(action.defaultBinding);
  if (conflict == null) return action;
  console.warn(
    `registerCommand: "${action.id}"'s default binding "${action.defaultBinding}" conflicts with "${conflict}" — registered unbound instead`,
  );
  return { ...action, defaultBinding: null };
}

/** Register a runtime action id + its handler in one call (catalog entry +
 *  handler, mirroring registerHandler's injection role for the shipped
 *  catalog). Fails fast on a duplicate id; demotes a conflicting default to
 *  unbound (with a warning) rather than silently shadowing a built-in chord.
 *  Returns an unregister closure that reverses all three effects (catalog
 *  entry, handler, lookup) — the same shape store.ts's subscribe returns.
 *  Command (void return via the closure; CQS). */
export function registerCommand(action: ShortcutAction, run: Handler): () => void {
  assertNewActionId(action.id);
  const registered = demoteConflictingDefault(action);
  runtimeActions.push(registered);
  handlers.set(registered.id, run);
  rebuildLookup();
  return () => {
    const idx = runtimeActions.indexOf(registered);
    if (idx !== -1) runtimeActions.splice(idx, 1);
    handlers.delete(registered.id);
    rebuildLookup();
  };
}

/** Subscribe the dispatcher to the keybindings setting: every change replaces
 *  the override map and rebuilds the reverse lookup (single sink, no hand
 *  fan-out). bind() applies the current value immediately, so defaults are live
 *  from boot. Idempotent — re-binding drops the prior subscription. Command. */
export function bindKeybindings(setting: Setting<Record<string, string>>): void {
  unbind?.();
  unbind = setting.bind((o) => {
    overrides = o;
    rebuildLookup();
  });
}

/** Run the handler bound to `chord`, if any. Returns whether it fired so the
 *  dispatcher knows whether to swallow the event. */
export function dispatchChord(chord: string): boolean {
  const id = lookup.get(chord);
  if (!id) return false;
  const handler = handlers.get(id);
  if (!handler) return false;
  handler();
  return true;
}

/** Stand the global dispatcher down (or back up) — used by the settings capture
 *  so the chord being assigned isn't also dispatched to its current action.
 *  Command (void). */
export function suppressDispatcher(on: boolean): void {
  suppressed = on;
}

/** Install the ONE global capture-phase keydown listener. Idempotent: a second
 *  call is a no-op, so the dispatcher is always a singleton. Capture phase +
 *  stopPropagation so a bound chord fires regardless of focus (chrome lives
 *  outside .cm-content) and doesn't leak into the editor. Command (void). */
export function installDispatcher(): void {
  if (installed) return;
  installed = true;
  window.addEventListener(
    "keydown",
    (e) => {
      if (suppressed) return;
      const chord = eventToChord(e);
      if (!chord) return;
      if (dispatchChord(chord)) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    { capture: true },
  );
}
