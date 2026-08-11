import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { createServer as createViteServer } from "vite";
import { startWorkspaceSmokeBridge } from "./lib/workspace-smoke-bridge.mjs";

const evidenceDir = resolve(process.env.INTEGRATED_RECOVERY_EVIDENCE ?? ".omo/evidence/code-review-remediation/task-8/integrated");
const fixtureRoot = await mkdtemp(join(tmpdir(), "mermark-integrated-recovery-"));
const vault = join(fixtureRoot, "vault");
const fixtureA = join(vault, "a.md");
const fixtureB = join(vault, "b.md");
const token = randomBytes(18).toString("hex");
const checks = [];
const events = [];

await mkdir(evidenceDir, { recursive: true });
await mkdir(vault, { recursive: true });
await writeFile(fixtureA, "# Fixture A\n\nalpha\n", "utf8");
await writeFile(fixtureB, "# Fixture B\n\nbeta\n", "utf8");

function check(id, condition, observable) {
  checks.push({ id, passed: Boolean(condition), observable });
}

async function focusPath(page, path) {
  const row = page.locator(`.explorer-item[data-path="${path}"]`);
  await row.waitFor();
  const items = page.locator(".explorer-item:visible");
  const paths = await items.evaluateAll((elements) => elements.map((element) => element.getAttribute("data-path")));
  const index = paths.indexOf(path);
  if (index < 0) throw new Error(`Explorer path is not visible: ${path}`);
  await page.locator('.explorer-item[tabindex="0"]').focus();
  await page.keyboard.press("Home");
  for (let step = 0; step < index; step += 1) await page.keyboard.press("ArrowDown");
  return row;
}

let bridge;
let vite;
let browser;
let viteBase = null;
try {
  bridge = await startWorkspaceSmokeBridge({ roots: [resolve("."), fixtureRoot], token, events });
  vite = await createViteServer({ mode: "browser", server: { host: "127.0.0.1", port: 0, strictPort: true } });
  await vite.listen();
  const base = vite.resolvedUrls?.local[0];
  if (!base) throw new Error("Vite did not publish a local URL");
  viteBase = base;
  browser = await chromium.launch({ headless: true });

  const openPage = async (path, useBridge = true) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addInitScript(() => { window.__TAURI_INTERNALS__ = {}; });
    const page = await context.newPage();
    page.on("console", (message) => events.push({ type: "console", text: message.text() }));
    page.on("pageerror", (error) => events.push({ type: "pageerror", text: String(error) }));
    const url = new URL(base);
    url.searchParams.set("file", path);
    if (useBridge) {
      url.searchParams.set("smokeBridge", bridge.url);
      url.searchParams.set("smokeToken", token);
    }
    await page.goto(url.toString(), { waitUntil: "networkidle" });
    await page.locator(".cm-content").waitFor({ timeout: 8000 });
    return { context, page };
  };

  {
    const { context, page } = await openPage("/mock/vault/index.md", false);
    await page.getByRole("button", { name: "탐색기" }).click();
    await focusPath(page, "/mock/vault/sample.pdf");
    await page.locator('.explorer-item[data-path="/mock/vault/sample.pdf"]').click();
    await page.locator(".pdf-viewer").waitFor({ timeout: 12000 });
    await page.getByRole("button", { name: "워크스페이스" }).click();
    const viewerVisibleWithWorkspace = await page.locator(".pdf-viewer").isVisible();
    await page.getByRole("button", { name: "탐색기" }).click();
    await focusPath(page, "/mock/vault/index.md");
    await page.locator('.explorer-item[data-path="/mock/vault/index.md"]').click();
    await page.locator(".cm-content:visible").waitFor();
    check("normal.editor-viewer-workspace-editor", viewerVisibleWithWorkspace && await page.locator(".pdf-viewer").count() === 0, {});
    check("normal.panel-mutual-exclusion", await page.locator(".explorer-aside").isVisible() && await page.locator(".workspace-aside").isHidden(), {});
    await page.screenshot({ path: join(evidenceDir, "01-normal-surface-transition.png"), fullPage: true });
    await context.close();
  }

  {
    const { context, page } = await openPage(fixtureA);
    await page.locator(".mode-toggle").click();
    const editor = page.locator(".cm-content:visible");
    await editor.click();
    await page.keyboard.press("Meta+End");
    await page.keyboard.insertText("\nINTEGRATED_DIRTY_BUFFER");
    await page.getByRole("button", { name: "탐색기" }).click();

    bridge.failNext("list_dir", vault, "directory rejected by integrated seam");
    await page.getByRole("button", { name: "현재 폴더 새로고침" }).click();
    await page.locator(".explorer-root-error").waitFor();
    await page.getByRole("button", { name: "워크스페이스" }).click();
    bridge.failNext("list_dir", vault, "directory rejected again after panel transition");
    await page.getByRole("button", { name: "탐색기" }).click();
    const listErrorText = await page.locator(".explorer-root-error").innerText();
    check("list-reject.single-korean-state", await page.locator(".explorer-root-error").count() === 1 && listErrorText.includes("현재 루트를 읽을 수 없습니다") && listErrorText.includes("루트 다시 선택") && await page.locator(".explorer-empty").count() === 0, { listErrorText });
    await page.screenshot({ path: join(evidenceDir, "02-list-recovery-after-panels.png"), fullPage: true });
    await page.getByRole("button", { name: "루트 다시 선택" }).click();
    await focusPath(page, fixtureB);
    check("list-reject.retry-and-focus-survive-panels", await page.locator(":focus").getAttribute("data-path") === fixtureB, {});
    await page.screenshot({ path: join(evidenceDir, "02b-list-retry-settled.png"), fullPage: true });

    await editor.click();
    await page.keyboard.press("Meta+End");
    await page.keyboard.insertText("\nINTEGRATED_OPEN_RECOVERY_DIRTY");
    await page.locator(`.explorer-item[data-path="${fixtureB}"]`).focus();
    bridge.failNext("read_file", fixtureB, "open rejected by integrated seam");
    await page.keyboard.press("Enter");
    const recovery = page.locator(".recovery-modal");
    await recovery.waitFor();
    const openTitle = await page.locator(".recovery-title").innerText();
    const openStatus = await page.locator(".save-status").getAttribute("data-state");
    check("open-reject.single-korean-recovery", await recovery.count() === 1 && openTitle === "파일을 열 수 없습니다", { openTitle });
    const openHasUnsaved = await page.evaluate(() => window.__mermark?.hasUnsaved?.() === true);
    const openText = await editor.innerText();
    const openMarkerRetained = openText.includes("INTEGRATED_DIRTY_BUFFER") && openText.includes("INTEGRATED_OPEN_RECOVERY_DIRTY");
    check("open-reject.dirty-buffer-retained", openHasUnsaved && openMarkerRetained && openStatus !== "saved", { hasUnsaved: openHasUnsaved, markerRetained: openMarkerRetained, status: openStatus });
    await page.screenshot({ path: join(evidenceDir, "03-open-recovery.png"), fullPage: true });
    await page.getByRole("button", { name: "계속 편집" }).click();
    check("open-reject.focus-restored", await page.locator(":focus").getAttribute("data-path") === fixtureB, {});

    bridge.failNext("watch_file", fixtureB, "watch rejected by integrated seam");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(250);
    const watcherErrors = events.filter((event) => event.type === "console" && event.text.includes("File watcher attach failed"));
    const watchSnapshot = bridge.snapshot();
    check("watch-reject.single-error-and-rollback", watcherErrors.length === 1 && watchSnapshot.watchedPath === fixtureA && watchSnapshot.maxWatcherCount === 1, { watcherErrors, watchSnapshot });
    check("watch-reject.editor-and-focus-retained", (await editor.innerText()).includes("INTEGRATED_DIRTY_BUFFER") && await page.locator(":focus").getAttribute("data-path") === fixtureB, {});
    await page.getByRole("button", { name: "워크스페이스" }).click();
    await page.getByRole("button", { name: "탐색기" }).click();
    await page.screenshot({ path: join(evidenceDir, "04-watch-rejection-rollback.png"), fullPage: true });

    await editor.click();
    await page.keyboard.press("Meta+End");
    await page.keyboard.insertText("\nINTEGRATED_DELETED_RECOVERY_DIRTY");
    await unlink(fixtureA);
    await page.evaluate(async () => {
      const eventModule = await import("/src/mocks/tauri-event.ts");
      await eventModule.emit("file-unavailable", { kind: "deleted", detail: "integrated deletion" });
    });
    await recovery.waitFor();
    const deletionTitle = await page.locator(".recovery-title").innerText();
    const deletionActions = await page.locator(".recovery-action").allTextContents();
    const deletionStatus = await page.locator(".save-status").getAttribute("data-state");
    check("deleted.single-korean-recovery-actions", await recovery.count() === 1 && deletionTitle === "파일이 삭제되었습니다" && ["다시 시도", "복구 사본 저장", "다른 이름으로 저장", "닫기/버리기"].every((label) => deletionActions.includes(label)), { deletionTitle, deletionActions });
    const deletionHasUnsaved = await page.evaluate(() => window.__mermark?.hasUnsaved?.() === true);
    const deletionText = await editor.innerText();
    const deletionMarkerRetained = deletionText.includes("INTEGRATED_DIRTY_BUFFER") && deletionText.includes("INTEGRATED_OPEN_RECOVERY_DIRTY") && deletionText.includes("INTEGRATED_DELETED_RECOVERY_DIRTY");
    const originalAbsent = await readFile(fixtureA, "utf8").catch(() => null) === null;
    check("deleted.buffer-and-original-retained", deletionHasUnsaved && deletionMarkerRetained && originalAbsent && deletionStatus === "recovery", { hasUnsaved: deletionHasUnsaved, markerRetained: deletionMarkerRetained, originalAbsent, status: deletionStatus });
    await page.screenshot({ path: join(evidenceDir, "05-deleted-buffer-recovery.png"), fullPage: true });
    await context.close();
  }
} finally {
  await browser?.close().catch(() => {});
  await vite?.close().catch(() => {});
  await bridge?.close().catch(() => {});
  await writeFile(join(evidenceDir, "integrated-recovery.json"), JSON.stringify({ mode: "browser-mode native-contract equivalent", viteBase, bridgeUrl: bridge?.url ?? null, fixtureRoot, checks, events, bridge: bridge?.snapshot?.() ?? null }, null, 2));
  await rm(fixtureRoot, { recursive: true, force: true });
  await writeFile(join(evidenceDir, "cleanup.txt"), `removed fixture root: ${fixtureRoot}\nclosed Playwright, Vite, and bridge servers\nclosed Vite URL: ${viteBase ?? "unknown"}\nclosed bridge URL: ${bridge?.url ?? "unknown"}\n`);
}

const failed = checks.filter((entry) => !entry.passed);
console.log(JSON.stringify({ checks: checks.length, passed: checks.length - failed.length, failed: failed.map((entry) => entry.id), evidenceDir }, null, 2));
if (failed.length > 0) process.exitCode = 1;
