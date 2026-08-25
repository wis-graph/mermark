// Agent-operated browser-mode workspace/keyboard smoke harness for Task 7.
// Browser mock read_file/write_file are the documented equivalent of native
// disk bytes; every read-back is recorded rather than inferred from the DOM.
//
// STRUCTURE: each scenario runs in its OWN try/catch via runScenario() so one
// dead scenario can never take the rest of the file down with it (that used
// to be a single top-level `try` wrapping every scenario — the 3rd one dying
// meant autosave/deletion-recovery/tab-preservation etc. never even ran, and
// the harness silently reported only the errors array instead of surfacing
// which scenarios were never reached). A scenario that throws is recorded as
// `{ failed: true, error }` in result.scenarios AND pushed onto result.errors
// — it must never just vanish from the JSON, because a gate that quietly
// skips a dead scenario is exactly the failure mode this rewrite exists to
// close.
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";

const base = process.env.TASK7_BROWSER_BASE ?? "http://127.0.0.1:14837";
const outDir = process.env.TASK7_EVIDENCE_DIR ?? ".omo/evidence/code-review-remediation/task-7";
await mkdir(outDir, { recursive: true });
const events = [];
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
const page = await context.newPage();
page.on("console", (message) => events.push({ type: `console:${message.type()}`, text: message.text() }));
page.on("pageerror", (error) => events.push({ type: "pageerror", text: error.message }));

const result = { base, scenarios: {}, errors: [] };
const path = "/mock/vault/plain.txt";
const marker = "TASK7_AUTOSAVE_BYTES_20260811";
const deletedMarker = "TASK7_DELETED_BUFFER_20260811";

// Routed through window.__mockInvoke (set by src/mocks/tauri-core.ts right
// after it defines `invoke`) rather than this script's own
// `import("/src/mocks/tauri-core.ts")`. A raw re-import is only guaranteed to
// hit the SAME module instance the running app is bound to when Vite has
// served that exact URL — querystring included — to both sides; any HMR
// invalidation since boot (e.g. another agent editing a src/ file while this
// dev server stays up) makes Vite hand the app a fresh `?t=...`-versioned
// copy with its own `store` Map, so this script's unversioned re-import ends
// up reading/writing a disconnected copy. __mockInvoke sidesteps the whole
// versioning question by reusing whichever instance actually booted the page.
async function invoke(cmd, args) {
  return page.evaluate(({ cmd, args }) => window.__mockInvoke(cmd, args), { cmd, args });
}
async function waitEditor(text) {
  await page.waitForFunction((expected) => document.querySelector(".cm-content")?.textContent?.includes(expected), text, { timeout: 10000 });
}
async function screenshot(name) {
  await page.screenshot({ path: `${outDir}/${name}.png`, fullPage: true });
}

/** Run one scenario in isolation: failures are captured (never rethrown) so
 *  every scenario after this one still gets a chance to run. */
async function runScenario(name, fn) {
  try {
    result.scenarios[name] = await fn();
  } catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    result.scenarios[name] = { failed: true, error: message };
    result.errors.push(`${name}: ${message}`);
  }
}

/** Move the explorer's ROVING focus cursor (the `focused` closure var behind
 *  `.is-focused` / tabIndex=0 in explorer-panel.ts) to the row at `targetPath`,
 *  by actually driving it through ArrowDown the way a keyboard user would.
 *  `Locator.focus()` on a row only moves the DOM's document.activeElement —
 *  the tree's delegated keydown handler reads the closure's `focused` var,
 *  not document.activeElement, so `.focus()` never re-points it. Calling
 *  `.focus()` on an arbitrary row and then pressing Enter/keydown activates
 *  whatever row the LAST arrow-key/click actually focused, not the row that
 *  merely received DOM focus — that mismatch is what silently opened
 *  demo.sqlite instead of plain.txt in the old IME scenario. */
async function focusRow(targetPath, { maxSteps = 200 } = {}) {
  const tree = page.locator(".explorer-tree");
  await tree.focus();
  await page.keyboard.press("Home");
  for (let i = 0; i < maxSteps; i++) {
    const current = await page.locator(".explorer-item.is-focused").getAttribute("data-path");
    if (current === targetPath) return;
    await page.keyboard.press("ArrowDown");
  }
  throw new Error(`focusRow: never reached ${targetPath} via roving focus within ${maxSteps} ArrowDown steps`);
}

let ready = false;
try {
  await page.goto(`${base}/?file=${encodeURIComponent("/mock/vault/index.md")}`, { waitUntil: "domcontentloaded" });
  await page.locator(".cm-content").waitFor({ timeout: 10000 });
  await page.locator(".explorer-btn").click();
  await page.locator(".explorer-tree").waitFor({ timeout: 10000 });
  await page.locator(`.explorer-item[data-path="${path}"]`).waitFor({ state: "visible", timeout: 10000 });
  ready = true;
} catch (error) {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  result.errors.push(`setup: ${message}`);
}

if (ready) {
  const tree = page.locator(".explorer-tree");

  // Explorer focus and arrows/Home/End: focus moves without opening a file.
  await runScenario("explorerFocus", async () => {
    await page.locator(".explorer-item.is-focused").focus();
    await page.keyboard.press("Home");
    const firstFocused = await page.locator(".explorer-item.is-focused").getAttribute("data-path");
    await page.keyboard.press("End");
    const lastFocused = await page.locator(".explorer-item.is-focused").getAttribute("data-path");
    await page.keyboard.press("ArrowUp");
    const afterArrow = await page.locator(".explorer-item.is-focused").getAttribute("data-path");
    return { firstFocused, lastFocused, afterArrow, treeFocus: await tree.evaluate((el) => el.contains(document.activeElement)) };
  });

  // IME Enter is composition-confirmation and must not activate the focused
  // row. Uses focusRow() (roving-focus-correct) rather than `.focus()` so the
  // scenario actually targets `path` instead of whatever row a prior
  // arrow-key press last landed the roving cursor on.
  await runScenario("imeEnter", async () => {
    await focusRow(path);
    await page.evaluate(() => document.querySelector(".explorer-tree")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", isComposing: true, bubbles: true, cancelable: true })));
    await page.waitForTimeout(150);
    return {
      viewerCount: await page.locator(".viewer-panel").count(),
      cmContentVisibleCount: await page.locator(".cm-content:visible").count(),
      focusedPathAfter: await page.locator(".explorer-item.is-focused").getAttribute("data-path"),
      targetPath: path,
    };
  });

  // Plain Enter opens in the current window and Cmd+Enter uses the mock's new-tab window path.
  await runScenario("enterAndCmdEnter", async () => {
    await focusRow(path);
    await page.keyboard.press("Enter");
    await waitEditor("Mermark");
    const currentPages = context.pages().length;
    await focusRow(path);
    await page.keyboard.press("Meta+Enter");
    await page.waitForTimeout(350);
    const out = { currentPagesBeforeCmdEnter: currentPages, pagesAfterCmdEnter: context.pages().length, newWindowOpened: context.pages().length > currentPages };
    for (const opened of context.pages().slice(1)) await opened.close();
    return out;
  });

  // Autosave observable: type, wait for the debounce, then read back mock disk bytes.
  // Later scenarios (deletionRecovery, appCloseEquivalent, recoveryBufferMarker)
  // build on the editor state this leaves behind, so if this one fails they
  // are likely to fail too — each still reports its own failure independently.
  await runScenario("autosave", async () => {
    await page.locator(".mode-toggle").click();
    const editor = page.locator(".cm-content:visible").first();
    await editor.click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type(`\n${marker}`);
    await waitEditor(marker);
    await page.waitForTimeout(700);
    const saved = await invoke("read_file", { path });
    await screenshot("workspace-autosave");
    return { readBackContainsMarker: saved.text.includes(marker), readBackBytes: new TextEncoder().encode(saved.text).byteLength, marker };
  });

  // Deletion recovery and cancellation retain the exact dirty buffer/tab.
  //
  // createWatcherHandoff.accepts() (file-watch.ts) only lets an event through
  // when its `path`+`generation` match the live watch session exactly — a
  // payload missing either field is silently dropped (recovery-modal never
  // opens), not an error, so the emit below must fetch the session via
  // currentMockWatchSession() rather than sending `{ kind, detail }` alone.
  await runScenario("deletionRecovery", async () => {
    const editor = page.locator(".cm-content:visible").first();
    await page.evaluate(async (detail) => {
      const session = window.__mockCurrentWatchSession();
      if (!session) throw new Error("deletionRecovery: no active mock watch session to target");
      await window.__mockEmit("file-unavailable", { path: session.path, generation: session.generation, kind: "deleted", detail });
    }, "TASK7 deleted recovery");
    await page.locator(".recovery-modal[role='dialog']").waitFor({ timeout: 10000 });
    const recoveryText = await page.locator("body").innerText();
    const beforeCancelHasMarker = recoveryText.includes(marker);
    await page.locator(".recovery-cancel").click();
    await waitEditor(marker);
    const out = { modalShown: beforeCancelHasMarker, bufferAfterCancel: (await editor.innerText()).includes(marker), activeTab: await page.locator(".workspace-vault-tab[data-active='true']").getAttribute("title") };
    await screenshot("workspace-deletion-recovery-cancelled");
    return out;
  });

  // App-close equivalent: flushSave is the same editor save sink used by the
  // native close-requested handler; read back bytes after the flush.
  //
  // `page.evaluate(() => window.__mermark)` pulls the controller object back
  // across the CDP boundary via structured clone, which DROPS its methods —
  // `controller.flushSave` is always `undefined` on the Node side even when
  // it's a real function in-page. Checking `typeof` on that marshalled copy
  // meant this scenario could never pass; every check + the actual call now
  // happens inside a single in-page evaluate instead.
  await runScenario("appCloseEquivalent", async () => {
    const flushSaveAvailable = await page.evaluate(() => typeof window.__mermark?.flushSave === "function");
    if (!flushSaveAvailable) throw new Error("dev editor controller flushSave unavailable");
    await page.evaluate(() => window.__mermark.flushSave());
    const closeSaved = await invoke("read_file", { path });
    return { flushSaveAvailable, readBackContainsMarker: closeSaved.text.includes(marker) };
  });

  // Preserve a separate marker for recovery evidence and ensure no write was
  // redirected to the deleted original by this browser-equivalent scenario.
  await runScenario("recoveryBufferMarker", async () => {
    const editor = page.locator(".cm-content:visible").first();
    await page.evaluate(() => window.__mermark.setMode("edit"));
    await editor.click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type(`\n${deletedMarker}`);
    await waitEditor(deletedMarker);
    return { present: (await editor.innerText()).includes(deletedMarker), originalPath: path };
  });

  // ---------------------------------------------------------------------
  // 2026-08-25 explorer regressions/features (folder-collapse-on-open fix +
  // active-document highlight). Global vaults already preserve their
  // explorer root unconditionally (shouldPreserveGlobalExplorerRoot), so the
  // folder-collapse regression only reproduces on a PERMANENT vault — this
  // registers /mock/vault as one, then reloads fresh. This reload is its own
  // mini-setup; if it fails, both scenarios below record their own failure
  // rather than the rest of the file silently not running.
  let permanentVaultReady = false;
  await runScenario("folderStaysExpandedOnDocumentOpen", async () => {
    const vaultId = "vault-%2Fmock%2Fvault";
    await page.evaluate(({ vaultId }) => {
      localStorage.setItem("mermark.workspaceState", JSON.stringify({
        workspaces: [{ workspaceId: "workspace-default", vaultIds: [vaultId], currentVaultId: vaultId, lastSelectedPermanentVaultId: vaultId }],
        vaults: [{ vaultId, workspaceId: "workspace-default", displayName: "vault", rootPath: "/mock/vault", persistenceKind: "permanent", explorerRoot: "/mock/vault" }],
        currentWorkspaceId: "workspace-default",
      }));
    }, { vaultId });
    await page.goto(`${base}/?file=${encodeURIComponent("/mock/vault/index.md")}`, { waitUntil: "domcontentloaded" });
    await page.locator(".cm-content").waitFor({ timeout: 10000 });
    await page.locator(".explorer-btn").click();
    await page.locator('.explorer-dir[data-path="/mock/vault/notes"]').waitFor({ timeout: 10000 });
    await page.locator('.explorer-dir[data-path="/mock/vault/notes"]').click(); // expand notes/
    await page.locator('.explorer-file[data-path="/mock/vault/notes/a.md"]').waitFor({ timeout: 10000 });
    await page.locator('.explorer-file[data-path="/mock/vault/notes/a.md"]').click(); // open a doc INSIDE the expanded folder
    await waitEditor("Mermark").catch(() => {}); // best-effort; the assertions below are the real gate
    await page.waitForTimeout(300);
    const out = {
      notesExpanded: await page.locator('.explorer-dir[data-path="/mock/vault/notes"]').getAttribute("aria-expanded"),
      aHighlighted: await page.locator('.explorer-file[data-path="/mock/vault/notes/a.md"]').evaluate((el) => el.classList.contains("is-selected")),
      treeRootStillVaultRoot: await page.locator(".breadcrumb").getAttribute("aria-label"),
    };
    await screenshot("workspace-folder-stays-expanded");
    permanentVaultReady = true;
    return out;
  });

  // Active-document highlight follows the newly-opened document (root-level
  // index.md), and the previous active row (a.md) loses its highlight.
  // Depends on the permanent-vault reload above having actually landed.
  await runScenario("activeHighlightMoves", async () => {
    if (!permanentVaultReady) throw new Error("skipped: folderStaysExpandedOnDocumentOpen did not reach a ready state");
    await page.locator('.explorer-file[data-path="/mock/vault/index.md"]').click();
    await page.waitForTimeout(300);
    const out = {
      notesStillExpanded: await page.locator('.explorer-dir[data-path="/mock/vault/notes"]').getAttribute("aria-expanded"),
      aHighlightedAfter: await page.locator('.explorer-file[data-path="/mock/vault/notes/a.md"]').evaluate((el) => el.classList.contains("is-selected")),
      indexHighlighted: await page.locator('.explorer-file[data-path="/mock/vault/index.md"]').evaluate((el) => el.classList.contains("is-selected")),
    };
    await screenshot("workspace-active-highlight-moves");
    return out;
  });
} else {
  result.errors.push("setup failed — no scenarios were run");
}

await page.screenshot({ path: `${outDir}/workspace-final.png`, fullPage: true }).catch(() => {});
await writeFile(`${outDir}/workspace-smoke.json`, JSON.stringify(result, null, 2));
await writeFile(`${outDir}/workspace-console.log`, events.map((event) => JSON.stringify(event)).join("\n") + "\n");
await browser.close();
const failedScenarios = Object.entries(result.scenarios).filter(([, v]) => v && v.failed).map(([k]) => k);
if (result.errors.length || failedScenarios.length) {
  console.error(JSON.stringify(result, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify(result, null, 2));
}
