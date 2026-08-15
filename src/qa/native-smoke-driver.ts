// Dev-only QA bridge driver (single-window-opening Todo 6). This module runs
// INSIDE the real debug Tauri webview — real @tauri-apps/api, real IPC, real
// window — and lets the window-routing-smoke.mjs harness drive it over a
// local HTTP long-poll bridge (scripts/qa-driver-bridge.mjs). This is NOT a
// browser mock and NOT Playwright/CDP: WKWebView has no CDP, and Vite's
// default (non-browser) mode never applies the src/mocks/* alias, so every
// command below hits the exact same @tauri-apps/api surface production code
// does (mermark-frontend skill: a mock cannot stand in for native proof).
//
// Release-mode dead-code guarantee lives at the ONE call site (src/main.ts):
// `if (import.meta.env.DEV && import.meta.env.VITE_QA_BRIDGE) void
// import("./qa/native-smoke-driver")`. `npm run build` statically folds that
// condition to `false` (DEV is a Vite compile-time constant in production
// builds), so this chunk is never emitted — verified mechanically by
// `grep -R native-smoke-driver dist/` (see _workspace/02_frontend_todo6_changes.md).
//
// Command vocabulary is FIXED at 7 names (design branch 3 — the SSOT this
// file and scripts/qa-driver-bridge.mjs both read; a change to either side
// must renotify the other). No eval/catch-all command: an unknown name is an
// explicit protocol error.

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { dispatchChord } from "../shortcuts/registry";
import { keybindingsSetting } from "../settings/app";
import { workspaceStorageKey, canonicalRootPath } from "../workspace/workspace-state";

const TOKEN_HEADER = "x-mermark-smoke-token";

export interface BridgeEndpoint {
  readonly url: string;
  readonly token: string;
}

/** Parse the `VITE_QA_BRIDGE` env shape ("http://host:port#token") into its
 *  url/token parts, or null when malformed. The ONE place that format is
 *  decoded — scripts/qa-driver-bridge.mjs is the one place it's formatted —
 *  so the two sides can never silently drift. Pure query. */
export function parseBridgeEnv(raw: string | undefined | null): BridgeEndpoint | null {
  if (!raw) return null;
  const hashIndex = raw.indexOf("#");
  if (hashIndex < 0) return null;
  const url = raw.slice(0, hashIndex);
  const token = raw.slice(hashIndex + 1);
  if (!url || !token) return null;
  try {
    new URL(url);
  } catch {
    return null;
  }
  return { url, token };
}

interface QueryDocResult {
  readonly textHead: string;
  readonly length: number;
  readonly selectors: Record<string, boolean>;
  readonly statusText: string | null;
  readonly debugVault: unknown;
}

/** Run `id`'s registered shortcut handler directly, bypassing the need for a
 *  bound keyboard chord (image.attach, this driver's only caller, ships
 *  unbound by default — SHORTCUT_ACTIONS: `defaultBinding: null`). Drives
 *  the REAL production dispatcher (registry.ts's dispatchChord) through a
 *  scratch keybinding override written via the same settings SSOT a real
 *  rebind uses (keybindingsSetting.set) — no reimplementation of dispatch,
 *  no new export off registry.ts. The scratch chord is a sentinel string
 *  that can never collide with a real stored chord (parseChord/eventToChord
 *  never produce "__"-wrapped tokens), so no other action's binding is ever
 *  shadowed. The override is restored in `finally`, so a thrown handler
 *  still leaves keybindingsSetting exactly as it found it. Throws when `id`
 *  has no registered handler — an explicit failure, not a silent no-op. */
async function runAction(id: string): Promise<void> {
  const sentinelChord = `__qa-run-action-${id}__`;
  const original = keybindingsSetting.get();
  keybindingsSetting.set({ ...original, [id]: sentinelChord });
  try {
    if (!dispatchChord(sentinelChord)) throw new Error(`runAction: no handler registered for "${id}"`);
  } finally {
    keybindingsSetting.set(original);
  }
}

/** Read the live editor's document text + arbitrary DOM selector presence —
 *  the "did the request land here" observable the routing scenarios assert
 *  on. Reads `window.__mermark` (main.ts's pre-existing dev-only debug
 *  expose — see src/main.ts's `openInWindow`, guarded the same
 *  `import.meta.env.DEV` way this driver is) rather than adding a second
 *  main.ts wire: fixture files carry their own filename as a body marker, so
 *  matching `textHead` against that marker identifies "which document is
 *  open" without a dedicated path export. Pure query (reads DOM/window,
 *  writes nothing). */
function queryDoc(args: { readonly selectors?: readonly string[] }): QueryDocResult {
  const controller = (window as unknown as {
    __mermark?: { view?: { state: { doc: { toString(): string; length: number } } } };
  }).__mermark;
  const text = controller?.view?.state.doc.toString() ?? "";
  const selectors: Record<string, boolean> = {};
  for (const sel of args.selectors ?? []) selectors[sel] = document.querySelector(sel) !== null;
  const statusText = document.querySelector(".status-pos")?.textContent ?? null;
  const debugVault = (window as unknown as { __mermarkDebugVault?: unknown }).__mermarkDebugVault ?? null;
  return { textHead: text.slice(0, 4000), length: text.length, selectors, statusText, debugVault };
}

/** Register one permanent vault directly into the workspace-state
 *  localStorage key (the same SSOT `src/workspace/workspace-state.ts` owns)
 *  and reload — the attachment scenarios (S9-S12) need a live permanent
 *  vault before `image.attach` can resolve a vault root. Mirrors
 *  WorkspaceStore.registerCanonicalVault's shape exactly (vaultId encoding,
 *  field names) so a real WorkspaceStore constructed after reload reads it
 *  as a normal, already-registered vault — no bespoke seed format.
 *
 *  Rust-canonicalizes `rootPath` via `canonicalize_path` FIRST, then applies
 *  the same JS-side `canonicalRootPath` normalization `cli-routing.ts`'s
 *  `routeCliFileResolved` also applies to every opened document's path.
 *  Skipping the Rust step (an earlier version of this helper did) registers
 *  the vault under the UN-resolved path while every document path resolves
 *  through `canonicalize_path` first — on macOS that turns `/var/...` into
 *  `/private/var/...`, so the two disagree on prefix and
 *  `isWithinRoot` (cli-routing.ts) never matches. The document then
 *  silently routes to the GLOBAL vault instead of the permanent one
 *  (MEASURED via this harness's own debug dump: `vaultIds`/
 *  `lastSelectedPermanentVaultId` still pointed at the seeded vault, but
 *  `currentVaultId` had been overwritten to `"vault-global"` by
 *  `routeCanonicalPath`'s global-fallback branch, which calls
 *  `store.selectVault` unconditionally on a route miss). A real vault
 *  registration flow (folder picker) never hits this, because its result
 *  already comes back through the SAME `canonicalize_path` IPC call before
 *  ever reaching `WorkspaceStore` — this mismatch is specific to this
 *  test-only seeding seam bypassing that step. */
async function seedVault(args: { readonly rootPath: string }): Promise<void> {
  const resolved = await invoke<string>("canonicalize_path", { path: args.rootPath }).catch(() => args.rootPath);
  const canonical = canonicalRootPath(resolved);
  const vaultId = `vault-${encodeURIComponent(canonical)}`;
  const displayName = canonical.split(/[\\/]/).filter(Boolean).slice(-1)[0] ?? canonical;
  const state = {
    workspaces: [
      { workspaceId: "workspace-default", vaultIds: [vaultId], currentVaultId: vaultId, lastSelectedPermanentVaultId: vaultId },
    ],
    vaults: [
      { vaultId, workspaceId: "workspace-default", displayName, rootPath: canonical, persistenceKind: "permanent" as const, explorerRoot: canonical },
    ],
    currentWorkspaceId: "workspace-default",
  };
  localStorage.setItem(workspaceStorageKey, JSON.stringify(state));
  location.reload();
}

type CommandHandler = (args: Record<string, unknown>) => Promise<unknown> | unknown;

/** The fixed 7-command dispatch table (design branch 3) — the single source
 *  both this driver and its tests read. `openPath` invokes the SAME
 *  production `open_path` command Cmd/Ctrl-click uses (no test-only IPC
 *  surface added).
 *
 *  `minimizeSelf` (not the design's original `focusSelf`): production code
 *  never calls `getCurrentWindow().setFocus()` from JS — window focus is
 *  driven Rust-side (`RoutingAction::Focus` in single_instance.rs, which
 *  bypasses the webview IPC permission gate entirely) — so
 *  `capabilities/default.json` never grants `core:window:allow-set-focus`,
 *  and a driver-side `setFocus()` call is rejected at the permission layer.
 *  The orchestrator's ruling (single-window-opening Todo 6 adjudication,
 *  2026-08-15) was NOT to add that capability (a real, non-dev-gated
 *  release IPC-surface increase) and instead to produce the same "focus
 *  moved to another live window" observable through
 *  `core:window:allow-minimize`, which IS already granted (used elsewhere
 *  in the app's own window chrome). Minimizing the frontmost window is a
 *  real macOS focus-transfer trigger — the next window in z-order becomes
 *  key and fires `WindowEvent::Focused(true)`, the same trace-observable
 *  event a real click would produce. */
const COMMANDS: Readonly<Record<string, CommandHandler>> = {
  openPath: (args) => invoke("open_path", { path: String(args.path ?? "") }),
  minimizeSelf: () => getCurrentWindow().minimize(),
  closeSelf: () => getCurrentWindow().close(),
  queryDoc: (args) => queryDoc(args as { selectors?: readonly string[] }),
  runAction: (args) => runAction(String(args.id ?? "")),
  seedVault: (args) => seedVault(args as { rootPath: string }),
  invokeRaw: (args) => invoke(String(args.cmd ?? ""), (args.args as Record<string, unknown>) ?? {}),
};

/** Resolve a bridge command name to its handler, or undefined outside the
 *  fixed vocabulary — the one place "is this a real bridge command"
 *  is decided (no eval/catch-all). Pure query. */
export function resolveCommand(name: string): CommandHandler | undefined {
  return COMMANDS[name];
}

interface BridgeCommandEnvelope {
  readonly commandId: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
}

async function pollOnce(endpoint: BridgeEndpoint, label: string): Promise<BridgeCommandEnvelope | null> {
  const response = await fetch(`${endpoint.url}/poll?label=${encodeURIComponent(label)}`, {
    headers: { [TOKEN_HEADER]: endpoint.token },
  });
  if (response.status === 204) return null;
  if (!response.ok) throw new Error(`qa bridge poll failed: ${response.status}`);
  return (await response.json()) as BridgeCommandEnvelope;
}

async function postResult(
  endpoint: BridgeEndpoint,
  commandId: string,
  outcome: { ok: true; value: unknown } | { ok: false; error: string },
): Promise<void> {
  await fetch(`${endpoint.url}/result`, {
    method: "POST",
    headers: { "content-type": "application/json", [TOKEN_HEADER]: endpoint.token },
    body: JSON.stringify({ commandId, ...outcome }),
  });
}

async function registerWithBridge(endpoint: BridgeEndpoint, label: string): Promise<void> {
  await fetch(`${endpoint.url}/register`, {
    method: "POST",
    headers: { "content-type": "application/json", [TOKEN_HEADER]: endpoint.token },
    body: JSON.stringify({ label }),
  });
}

let polling = false;

/** Long-poll the bridge for the next command addressed to this window's
 *  label, execute it, and report the result back — forever, until the page
 *  unloads (a `seedVault` reload or `closeSelf` ends this loop naturally by
 *  tearing down the JS realm it runs in). A poll/post network hiccup just
 *  retries on the next tick — the harness owns timeouts on its side, not
 *  this loop. `polling` guards against a second concurrent loop if
 *  `startNativeSmokeDriver` is ever invoked twice in the same realm. */
async function pollBridgeCommands(endpoint: BridgeEndpoint, label: string): Promise<void> {
  if (polling) return;
  polling = true;
  for (;;) {
    let envelope: BridgeCommandEnvelope | null;
    try {
      envelope = await pollOnce(endpoint, label);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
      continue;
    }
    if (!envelope) continue;
    const handler = resolveCommand(envelope.name);
    try {
      if (!handler) throw new Error(`unknown qa bridge command: "${envelope.name}"`);
      const value = await handler(envelope.args);
      await postResult(endpoint, envelope.commandId, { ok: true, value: value ?? null });
    } catch (error) {
      await postResult(endpoint, envelope.commandId, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/** Boot entry: parse the bridge env, register this window's label, then poll
 *  forever. A malformed/absent `raw` is a silent no-op (not a throw) so a
 *  DEV build with the gate flipped on by accident but no real bridge running
 *  never breaks boot. */
export async function startNativeSmokeDriver(raw: string | undefined): Promise<void> {
  const endpoint = parseBridgeEnv(raw);
  if (!endpoint) return;
  const label = getCurrentWindow().label;
  await registerWithBridge(endpoint, label);
  void pollBridgeCommands(endpoint, label);
}

// Import-time side effect — this is what src/main.ts's gate
// (`void import("./qa/native-smoke-driver")`) actually triggers; there is no
// second call site. Safe under vitest/jsdom: VITE_QA_BRIDGE is unset there,
// so parseBridgeEnv short-circuits to null before any @tauri-apps/api call.
if (typeof window !== "undefined") {
  void startNativeSmokeDriver(import.meta.env.VITE_QA_BRIDGE as string | undefined);
}
