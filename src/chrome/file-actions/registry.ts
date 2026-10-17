// File-action registry: the "○○로 열기" entries of the explorer's file-row
// context menu. Same plain-array + named-function shape as
// chrome/viewer/registry.ts, but a PURE CATALOG — it does not render the menu,
// own the remote-vault gate, or decide platform (callers do).
//
// Unlike viewers (one file → one viewer, first-claim-wins), a menu is a list
// of choices: every action claiming an extension is returned, in registration
// order (built-ins register at boot, so they come first).

import { isCanonicalExtension } from "../extension-format";

export interface FileAction {
  /** Unique within the registry. Built-in: "preview", "browser". Extension
   *  convention: "ext.<name>.<action>". Never rename. */
  id: string;
  /** Menu text, verbatim (e.g. "미리보기로 열기"). */
  label: string;
  /** Extensions this action applies to, in `extensionOf` format (lowercase,
   *  no leading dot). Must be non-empty. */
  extensions: readonly string[];
  /** Receives a LOCAL absolute path only (remote-vault rows are disabled by the
   *  host and never reach here). Command. Handle your own failures; the host
   *  additionally catches throws/rejects (runFileAction). */
  run(absPath: string): void | Promise<void>;
}

const actions: FileAction[] = [];

/** Throws on a duplicate id (developer error). Pure query (raises). */
function assertNewFileActionId(id: string): void {
  if (actions.some((a) => a.id === id)) {
    throw new Error(`registerFileAction: action id "${id}" is already registered`);
  }
}

/** Throws on an empty extension list (a dead action that claims nothing) or a
 *  non-canonical extension (never matches `fileActionsFor`). Pure query
 *  (raises). */
function assertFileActionExtensions(exts: readonly string[]): void {
  if (exts.length === 0) {
    throw new Error("registerFileAction: extensions must not be empty");
  }
  for (const ext of exts) {
    if (!isCanonicalExtension(ext)) {
      throw new Error(`registerFileAction: extension "${ext}" must be lowercase with no leading dot`);
    }
  }
}

/** Command (void). */
export function registerFileAction(a: FileAction): void {
  assertNewFileActionId(a.id);
  assertFileActionExtensions(a.extensions);
  actions.push(a);
}

/** Every action claiming `ext`, in registration order. Pure query. */
export function fileActionsFor(ext: string): readonly FileAction[] {
  return actions.filter((a) => a.extensions.includes(ext));
}

/** Runs `a` on `absPath`; a sync throw or async rejection is logged, never
 *  propagated (a failed external launch must not break the menu/app).
 *  Command (void). */
export function runFileAction(a: FileAction, absPath: string): void {
  const report = (err: unknown): void => console.error(`File action "${a.id}" failed`, err);
  try {
    void Promise.resolve(a.run(absPath)).catch(report);
  } catch (err) {
    report(err);
  }
}
