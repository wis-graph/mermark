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
import { SHORTCUT_ACTIONS } from "./actions";
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
  const action = SHORTCUT_ACTIONS.find((a) => a.id === id);
  return action ? action.defaultBinding : null;
}

/** The action id already bound to `chord` (ignoring `exceptId`, the row being
 *  edited), or null if free. Compares against effective bindings so a would-be
 *  duplicate is rejected before it shadows another command. Pure query. */
export function findConflict(chord: string, exceptId?: string): string | null {
  for (const a of SHORTCUT_ACTIONS) {
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
  for (const a of SHORTCUT_ACTIONS) {
    const b = effectiveBinding(a.id);
    if (b) lookup.set(b, a.id);
  }
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
