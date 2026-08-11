import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { createServer as createViteServer } from "vite";
import { startWorkspaceSmokeBridge } from "./lib/workspace-smoke-bridge.mjs";

const evidenceDir = resolve(process.env.WORKSPACE_SMOKE_EVIDENCE ?? ".omo/evidence/code-review-remediation/task-7-native-run");
const events = [];
const checks = [];
const token = randomBytes(18).toString("hex");
const fixtureRoot = await mkdtemp(join(tmpdir(), "mermark-workspace-smoke-"));
const vault = join(fixtureRoot, "fixture-vault");
const fixtureA = join(vault, "a.md");
const fixtureB = join(vault, "b.md");
const readme = resolve("README.md");
// This red control changes only the app-close marker expected after a real disk
// read. `check` itself always records the truth of the supplied predicate.
const appCloseExpectedMarker = process.env.WORKSPACE_SMOKE_FORCE_FAILURE === "1"
  ? "APP_CLOSE_MARKER__INTENTIONALLY_ABSENT_RED_CONTROL"
  : "APP_CLOSE_MARKER";
const redControl = process.env.WORKSPACE_SMOKE_FORCE_FAILURE === "1"
  ? { targetCheck: "app-close.save-disk-bytes", expectedMarker: appCloseExpectedMarker }
  : null;
await mkdir(evidenceDir, { recursive: true });
await mkdir(vault, { recursive: true });
await writeFile(fixtureA, "# Fixture A\n\nalpha\n", "utf8");
await writeFile(fixtureB, "# Fixture B\n\nbeta\n", "utf8");

function check(id, condition, observable) {
  const passed = Boolean(condition);
  checks.push({ id, passed, observable });
}

async function waitForDisk(path, marker, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = await readFile(path, "utf8").catch(() => "");
    if (text.includes(marker)) return text;
    await new Promise((resolveWait) => setTimeout(resolveWait, 80));
  }
  return readFile(path, "utf8").catch(() => "");
}

async function focusExplorerPath(page, path) {
  const items = page.locator(".explorer-item:visible");
  const paths = await items.evaluateAll((elements) => elements.map((element) => element.getAttribute("data-path")));
  const index = paths.indexOf(path);
  if (index < 0) throw new Error(`Explorer path is not visible: ${path}`);
  await page.locator('.explorer-item[tabindex="0"]').focus();
  await page.keyboard.press("Home");
  for (let step = 0; step < index; step += 1) await page.keyboard.press("ArrowDown");
}

let bridge;
let vite;
let browser;
try {
  bridge = await startWorkspaceSmokeBridge({ roots: [resolve("."), fixtureRoot], token, events });
  vite = await createViteServer({ mode: "browser", server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await vite.listen();
  const base = vite.resolvedUrls?.local[0];
  if (!base) throw new Error("Vite did not publish a local URL");
  browser = await chromium.launch({ headless: true });

  const openPage = async (path) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addInitScript(() => { window.__TAURI_INTERNALS__ = {}; });
    const page = await context.newPage();
    page.on("console", (message) => events.push({ type: "console", text: message.text() }));
    page.on("pageerror", (error) => events.push({ type: "pageerror", text: String(error) }));
    const url = new URL(base);
    url.searchParams.set("file", path);
    url.searchParams.set("smokeBridge", bridge.url);
    url.searchParams.set("smokeToken", token);
    await page.goto(url.toString(), { waitUntil: "networkidle" });
    await page.locator(".cm-content").waitFor({ timeout: 8000 });
    return { context, page };
  };

  {
    const { context, page } = await openPage(readme);
    await page.getByRole("button", { name: "탐색기" }).click();
    const readmeRow = page.locator(`.explorer-item[data-path="${readme}"]`);
    await readmeRow.waitFor(); await focusExplorerPath(page, readme);
    await page.keyboard.press("ArrowUp");
    const upPath = await page.locator(":focus").getAttribute("data-path");
    await page.keyboard.press("ArrowDown");
    check("explorer.arrow-up-down-focus", await page.locator(":focus").getAttribute("data-path") === readme && upPath !== readme, { upPath });
    await page.keyboard.press("Home"); const home = await page.locator(":focus").getAttribute("data-path");
    await page.keyboard.press("End"); const end = await page.locator(":focus").getAttribute("data-path");
    check("explorer.home-end", home !== null && end !== null && home !== end, { home, end });
    const directory = page.locator(".explorer-dir:visible").first();
    const directoryPath = await directory.getAttribute("data-path");
    if (!directoryPath) throw new Error("Explorer fixture has no visible directory");
    await focusExplorerPath(page, directoryPath); await page.keyboard.press("ArrowRight");
    await page.waitForFunction((path) => document.querySelector(`.explorer-dir[data-path="${path}"]`)?.getAttribute("aria-expanded") === "true", directoryPath);
    const expanded = await directory.getAttribute("aria-expanded"); await page.keyboard.press("ArrowLeft");
    check("explorer.right-left-folder", expanded === "true" && await directory.getAttribute("aria-expanded") === "false", { directoryPath });
    await focusExplorerPath(page, readme); await page.keyboard.press("Enter"); await page.waitForTimeout(150);
    check("explorer.enter-current-window", context.pages().length === 1 && (await page.locator(".cm-content").innerText()).includes("mermark"), { pages: context.pages().length });
    await page.getByRole("button", { name: "탐색기" }).click(); await page.getByRole("button", { name: "탐색기" }).click();
    await readmeRow.waitFor(); await focusExplorerPath(page, readme); await page.keyboard.press("Meta+Enter"); await page.waitForTimeout(250);
    check("explorer.cmd-enter-new-window", context.pages().length === 2, { pages: context.pages().length });
    await page.bringToFront(); await page.getByRole("button", { name: "워크스페이스" }).click();
    check("panel.explorer-to-workspace", await page.locator(".explorer-aside").isHidden() && await page.locator(".workspace-aside").isVisible(), {});
    await page.screenshot({ path: join(evidenceDir, "01-readme-keyboard-workspace.png"), fullPage: true });
    await context.close();
  }

  {
    const { context, page } = await openPage(fixtureA);
    await page.locator(".mode-toggle").click();
    const editor = page.locator(".cm-content:visible"); await editor.click(); await page.keyboard.press("Meta+End");
    const koreanMarker = "한글 입력 안전"; await page.keyboard.insertText(`\n${koreanMarker}`);
    const diskAfterIme = await waitForDisk(fixtureA, koreanMarker);
    await writeFile(join(evidenceDir, "autosave-disk.txt"), diskAfterIme, "utf8");
    check("ime.korean-autosave-bytes", diskAfterIme.includes(koreanMarker), { bytes: Buffer.byteLength(diskAfterIme) });
    await page.getByRole("button", { name: "탐색기" }).click();
    const rowB = page.locator(`.explorer-item[data-path="${fixtureB}"]`); await rowB.waitFor(); await focusExplorerPath(page, fixtureB);
    await page.dispatchEvent(`.explorer-item[data-path="${fixtureB}"]`, "compositionstart", { data: "ㅎ" });
    await page.dispatchEvent(`.explorer-item[data-path="${fixtureB}"]`, "keydown", { key: "Process", code: "Process", isComposing: true });
    await page.dispatchEvent(`.explorer-item[data-path="${fixtureB}"]`, "compositionend", { data: "한" });
    await page.keyboard.down("Meta"); await page.keyboard.up("Meta");
    check("ime.modifier-keeps-explorer-focus", await page.locator(":focus").getAttribute("data-path") === fixtureB && context.pages().length === 1, {});
    await page.keyboard.press("Enter");
    await page.locator(".cm-content").filter({ hasText: "Fixture B" }).waitFor();
    await page.getByRole("button", { name: "워크스페이스" }).click();
    const tabs = page.locator(".workspace-vault-tab"); const before = await tabs.count();
    await tabs.last().focus(); await page.keyboard.press("Home");
    await page.waitForFunction((path) => document.querySelector(".workspace-vault-tab[data-active='true']")?.getAttribute("title") === path, fixtureA);
    const homeTitle = await page.locator(".workspace-vault-tab[data-active='true']").getAttribute("title");
    await page.locator(".workspace-vault-tab[data-active='true']").focus(); await page.keyboard.press("End");
    await page.waitForFunction((path) => document.querySelector(".workspace-vault-tab[data-active='true']")?.getAttribute("title") === path, fixtureB);
    const endTitle = await page.locator(".workspace-vault-tab[data-active='true']").getAttribute("title");
    check("tabs.keyboard-switch", before >= 2 && homeTitle === fixtureA && endTitle === fixtureB, { before, homeTitle, endTitle });
    await page.getByRole("button", { name: "b.md 탭 닫기" }).click();
    await page.waitForFunction((count) => document.querySelectorAll(".workspace-vault-tab").length === count - 1, before);
    check("tabs.close-fallback", await tabs.count() === before - 1 && (await page.locator(".cm-content").innerText()).includes(koreanMarker), { after: await tabs.count() });
    await page.screenshot({ path: join(evidenceDir, "02-korean-tabs-autosave.png"), fullPage: true }); await context.close();
  }

  {
    await writeFile(fixtureA, "# Delete me\n", "utf8");
    const { context, page } = await openPage(fixtureA);
    await page.locator(".mode-toggle").click(); const editor = page.locator(".cm-content:visible");
    await editor.click(); await page.keyboard.press("Meta+End"); await page.keyboard.insertText("\nDELETION_BUFFER_MARKER"); await unlink(fixtureA);
    await page.evaluate(async () => { const eventModule = await import("/src/mocks/tauri-event.ts"); await eventModule.emit("file-unavailable", { kind: "deleted", detail: "workspace smoke forced deletion" }); });
    const recovery = page.locator(".recovery-modal"); await recovery.waitFor(); const retry = page.getByRole("button", { name: "다시 시도" });
    check("deletion.recovery-initial-focus", await retry.evaluate((element) => element === document.activeElement), {});
    await retry.click(); await page.waitForTimeout(150);
    check("deletion.rejected-retry-focus", await retry.evaluate((element) => element === document.activeElement) && await recovery.isVisible(), {});
    const original = await readFile(fixtureA, "utf8").catch(() => null);
    await writeFile(join(evidenceDir, "deletion-disk-state.json"), JSON.stringify({ originalExists: original !== null, original }, null, 2));
    check("deletion.original-not-recreated", original === null, { original });
    check("deletion.buffer-retained", (await page.locator("body").innerText()).includes("DELETION_BUFFER_MARKER"), {});
    await page.screenshot({ path: join(evidenceDir, "03-deletion-rejected-recovery.png"), fullPage: true }); await context.close();
  }

  {
    await writeFile(fixtureB, "# Close save\n", "utf8");
    const { context, page } = await openPage(fixtureB);
    await page.locator(".mode-toggle").click(); await page.locator(".cm-content:visible").click();
    await page.keyboard.press("Meta+End"); await page.keyboard.insertText("\nAPP_CLOSE_MARKER"); await page.evaluate(() => window.__mockRequestClose?.());
    await page.waitForFunction(() => window.__mockWindowState?.destroyed === true, null, { timeout: 5000 }).catch(() => {});
    const closeBytes = await readFile(fixtureB, "utf8");
    await writeFile(join(evidenceDir, "app-close-disk.txt"), closeBytes, "utf8");
    check("app-close.save-disk-bytes", closeBytes.includes(appCloseExpectedMarker), {
      bytes: Buffer.byteLength(closeBytes),
      expectedMarker: appCloseExpectedMarker,
      productionMarkerPresent: closeBytes.includes("APP_CLOSE_MARKER"),
    });
    check("app-close.destroy-after-save", await page.evaluate(() => window.__mockWindowState?.destroyed === true), {});
    await page.screenshot({ path: join(evidenceDir, "04-app-close-saved.png"), fullPage: true }); await context.close();
  }
} finally {
  await browser?.close().catch(() => {}); await vite?.close().catch(() => {}); await bridge?.close().catch(() => {});
  await writeFile(join(evidenceDir, "workspace-smoke.json"), JSON.stringify({ mode: "browser-mode native-contract equivalent", nativeLimitation: "Tauri 2 WebDriver is unsupported on macOS; disk IPC and close events use browser-only test seams.", redControl, fixtureRoot, checks, events }, null, 2));
  await rm(fixtureRoot, { recursive: true, force: true });
  await writeFile(join(evidenceDir, "cleanup.txt"), `removed fixture root: ${fixtureRoot}\nclosed Playwright, Vite, and bridge servers\n`);
}

const failed = checks.filter((entry) => !entry.passed);
console.log(JSON.stringify({ checks: checks.length, passed: checks.length - failed.length, failed: failed.map((entry) => entry.id), evidenceDir }, null, 2));
if (failed.length > 0) process.exitCode = 1;
