// The runtime feature registry: plain arrays + a listener Set, no reactive
// framework (cold-load constraint — see CLAUDE.md). This is the ONE place
// InlineFeature/BlockFeature lists live at runtime; index.ts seeds it at
// module load with the shipped catalogs (in shipped order — that order IS
// the enter/match dispatch order, so preserving it is preserving behavior),
// and extensions/tests add to it afterward via registerInlineFeature /
// registerBlockFeature.
//
// CQS: register*/unregister are commands (void-ish — the returned closure is
// itself a command, mirroring the settings store's subscribe/unsubscribe
// shape). current*Features()/onFeaturesChanged are pure queries/subscriptions.
import type { InlineFeature, BlockFeature } from "./core";

const inline: InlineFeature[] = [];
const block: BlockFeature[] = [];
const listeners = new Set<() => void>();

function notify(): void {
  for (const fn of listeners) fn();
}

/** Register an inline feature. Appended by default (shipped features keep
 *  claiming their nodes first); `{ prepend: true }` puts it at the front of
 *  the byNode dispatch order instead — see registerBlockFeature's doc for why
 *  a feature would need that. Returns an unregister closure (splice + notify).
 *  Command. */
export function registerInlineFeature(f: InlineFeature, opts?: { prepend?: boolean }): () => void {
  if (opts?.prepend) inline.unshift(f);
  else inline.push(f);
  notify();
  return () => {
    const idx = inline.indexOf(f);
    if (idx !== -1) inline.splice(idx, 1);
    notify();
  };
}

/** Register a block feature. Default is append (shipped 5 keep first claim).
 *  `{ prepend: true }` exists because `codeBlock` is a catch-all fallback for
 *  every FencedCode node that isn't mermaid (features/code-block.ts) — a new
 *  fenced-language widget (the most likely extension use case) must be tried
 *  BEFORE codeBlock or codeBlock claims the node first under first-claim-wins
 *  (core.ts's computeSpecs). Returns an unregister closure. Command. */
export function registerBlockFeature(f: BlockFeature, opts?: { prepend?: boolean }): () => void {
  if (opts?.prepend) block.unshift(f);
  else block.push(f);
  notify();
  return () => {
    const idx = block.indexOf(f);
    if (idx !== -1) block.splice(idx, 1);
    notify();
  };
}

/** The current inline feature list, in dispatch order. Pure query. */
export function currentInlineFeatures(): readonly InlineFeature[] {
  return inline;
}

/** The current block feature list, in dispatch order. Pure query. */
export function currentBlockFeatures(): readonly BlockFeature[] {
  return block;
}

/** Subscribe to any registration/unregistration. Fires once per change; does
 *  NOT fire on subscribe (change-only, like Setting.subscribe — the seeding
 *  in index.ts runs before any listener exists, so the initial 20 features
 *  never spuriously notify). Returns an unsubscribe function. */
export function onFeaturesChanged(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
