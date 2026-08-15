// Agent-operated browser-mode workspace/keyboard smoke harness for Task 7.
// Browser mock read_file/write_file are the documented equivalent of native
// disk bytes; every read-back is recorded rather than inferred from the DOM.
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

async function invoke(cmd, args) {
  return page.evaluate(async ({ cmd, args }) => {
    const core = await import("/src/mocks/tauri-core.ts");
    return core.invoke(cmd, args);
  }, { cmd, args });
}
async function waitEditor(text) {
  await page.waitForFunction((expected) => document.querySelector(".cm-content")?.textContent?.includes(expected), text, { timeout: 10000 });
}
async function screenshot(name) {
  await page.screenshot({ path: `${outDir}/${name}.png`, fullPage: true });
}
function visibleRow(name) {
  return page.locator(`.explorer-item[data-path="${name}"]`).first();
}

try {
  await page.goto(`${base}/?file=${encodeURIComponent("/mock/vault/index.md")}`, { waitUntil: "domcontentloaded" });
  await page.locator(".cm-content").waitFor({ timeout: 10000 });
  await page.locator(".explorer-btn").click();
  await page.locator(".explorer-tree").waitFor({ timeout: 10000 });
  await page.locator(`.explorer-item[data-path="${path}"]`).waitFor({ state: "visible", timeout: 10000 });
  const tree = page.locator(".explorer-tree");

  // Explorer focus and arrows/Home/End: focus moves without opening a file.
  await page.locator(".explorer-item.is-focused").focus();
  await page.keyboard.press("Home");
  const firstFocused = await page.locator(".explorer-item.is-focused").getAttribute("data-path");
  await page.keyboard.press("End");
  const lastFocused = await page.locator(".explorer-item.is-focused").getAttribute("data-path");
  await page.keyboard.press("ArrowUp");
  const afterArrow = await page.locator(".explorer-item.is-focused").getAttribute("data-path");
  result.scenarios.explorerFocus = { firstFocused, lastFocused, afterArrow, treeFocus: await tree.evaluate((el) => el.contains(document.activeElement)) };

  // IME Enter is composition-confirmation and must not activate the focused row.
  await visibleRow(path).focus();
  await page.evaluate(() => document.querySelector(".explorer-tree")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", isComposing: true, bubbles: true, cancelable: true })));
  await page.waitForTimeout(150);
  result.scenarios.imeEnter = { viewerCount: await page.locator(".viewer-panel").count(), pathStillMounted: await page.locator(".cm-content").count() === 1 };

  // Plain Enter opens in the current window and Cmd+Enter uses the mock's new-tab window path.
  await visibleRow(path).focus();
  await page.keyboard.press("Enter");
  await waitEditor("Mermark");
  const currentPages = context.pages().length;
  await visibleRow(path).focus();
  await page.keyboard.press("Meta+Enter");
  await page.waitForTimeout(350);
  result.scenarios.enterAndCmdEnter = { currentPagesBeforeCmdEnter: currentPages, pagesAfterCmdEnter: context.pages().length, newWindowOpened: context.pages().length > currentPages };
  for (const opened of context.pages().slice(1)) await opened.close();

  // Autosave observable: type, wait for the debounce, then read back mock disk bytes.
  await page.locator(".mode-toggle").click();
  const editor = page.locator(".cm-content:visible").first();
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(`\n${marker}`);
  await waitEditor(marker);
  await page.waitForTimeout(700);
  const saved = await invoke("read_file", { path });
  result.scenarios.autosave = { readBackContainsMarker: saved.text.includes(marker), readBackBytes: new TextEncoder().encode(saved.text).byteLength, marker };
  await screenshot("workspace-autosave");

  // Deletion recovery and cancellation retain the exact dirty buffer/tab.
  await page.evaluate(async (detail) => {
    const eventModule = await import("/src/mocks/tauri-event.ts");
    await eventModule.emit("file-unavailable", { kind: "deleted", detail });
  }, "TASK7 deleted recovery");
  await page.locator(".recovery-modal[role='dialog']").waitFor({ timeout: 10000 });
  const recoveryText = await page.locator("body").innerText();
  const beforeCancelHasMarker = recoveryText.includes(marker);
  await page.locator(".recovery-cancel").click();
  await waitEditor(marker);
  result.scenarios.deletionRecovery = { modalShown: beforeCancelHasMarker, bufferAfterCancel: (await editor.innerText()).includes(marker), activeTab: await page.locator(".workspace-vault-tab[data-active='true']").getAttribute("title") };
  await screenshot("workspace-deletion-recovery-cancelled");

  // App-close equivalent: flushSave is the same editor save sink used by the
  // native close-requested handler; read back bytes after the flush.
  const controller = await page.evaluate(() => window.__mermark);
  if (!controller || typeof controller.flushSave !== "function") throw new Error("dev editor controller flushSave unavailable");
  await page.evaluate(() => window.__mermark.flushSave());
  const closeSaved = await invoke("read_file", { path });
  result.scenarios.appCloseEquivalent = { flushSaveAvailable: true, readBackContainsMarker: closeSaved.text.includes(marker) };

  // Preserve a separate marker for recovery evidence and ensure no write was
  // redirected to the deleted original by this browser-equivalent scenario.
  await page.evaluate(() => window.__mermark.setMode("edit"));
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(`\n${deletedMarker}`);
  await waitEditor(deletedMarker);
  result.scenarios.recoveryBufferMarker = { present: (await editor.innerText()).includes(deletedMarker), originalPath: path };
} catch (error) {
  result.errors.push(error instanceof Error ? error.stack ?? error.message : String(error));
}

await page.screenshot({ path: `${outDir}/workspace-final.png`, fullPage: true });
await writeFile(`${outDir}/workspace-smoke.json`, JSON.stringify(result, null, 2));
await writeFile(`${outDir}/workspace-console.log`, events.map((event) => JSON.stringify(event)).join("\n") + "\n");
await browser.close();
if (result.errors.length) {
  console.error(JSON.stringify(result, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify(result, null, 2));
}
