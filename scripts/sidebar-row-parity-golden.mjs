// CDP Golden Master for the workspace-sidebar overhaul (2026-11-14):
// "워크스페이스와 볼트 탐색기의 간격기준이 달라서" + tabs moved into the explorer.
//
// The vitest style contract (tests/sidebar-row-metrics.test.ts) proves the CSS
// TEXT consumes one set of row tokens. This golden proves the LIVE GEOMETRY:
// a workspace vault row sits on the same column grid as an explorer folder row
// (row height, chevron/glyph/name x, indent step), at zoom 1 AND 1.2, plus the
// open-document count and the explorer's "열린 파일" view smoke.
//
//   node scripts/sidebar-row-parity-golden.mjs /tmp/sidebar-row-parity.json
//
// Assumes `npm run dev:browser` + Chrome --remote-debugging-port=9222 (CDP_PORT
// overridable) and window.__mermark (DEV build). Skeleton = sidebar-zoom-golden.mjs.
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
import { assertPageRendered } from "./lib/preflight.mjs";

const out = process.argv[2] ?? "/tmp/sidebar-row-parity.json";
const url = process.argv[3] ?? "http://localhost:1430/?file=/mock/vault/index.md";
const shotBase = out.replace(/\.json$/, "");
const TOL = 0.5;

const CDP_PORT = process.env.CDP_PORT ?? "9222";
const ver = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
const browser = await chromium.connectOverCDP(ver.webSocketDebuggerUrl);
const ctx = browser.contexts()[0] ?? (await browser.newContext());
const page = ctx.pages()[0] ?? (await ctx.newPage());

const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
await page.setViewportSize({ width: 1200, height: 900 });

const VAULT_ID = "vault-%2Fmock%2Fvault";
const NOTES_ID = "vault-%2Fmock%2Fvault%2Fnotes";
const TAB_PATHS = ["/mock/vault/index.md", "/mock/vault/plain.txt", "/mock/vault/notes/a.md"];

/** Seed: permanent vault + its sub-vault Notes, 3 tabs on the parent. Optional zoom. */
async function seed(fontScale) {
  await page.evaluate(({ VAULT_ID, NOTES_ID, TAB_PATHS, fontScale }) => {
    localStorage.clear();
    localStorage.setItem("mermark.workspaceState", JSON.stringify({
      workspaces: [{ workspaceId: "workspace-default", vaultIds: [VAULT_ID, NOTES_ID], currentVaultId: VAULT_ID, lastSelectedPermanentVaultId: VAULT_ID }],
      vaults: [
        { vaultId: VAULT_ID, workspaceId: "workspace-default", displayName: "Vault", rootPath: "/mock/vault", persistenceKind: "permanent", explorerRoot: "/mock/vault" },
        { vaultId: NOTES_ID, workspaceId: "workspace-default", displayName: "Notes", rootPath: "/mock/vault/notes", persistenceKind: "permanent", explorerRoot: "/mock/vault/notes" },
      ],
      currentWorkspaceId: "workspace-default",
    }));
    localStorage.setItem(`mermark.vaultTabs.${VAULT_ID}`, JSON.stringify({
      vaultId: VAULT_ID,
      tabs: TAB_PATHS.map((path, i) => ({ tabId: `t${i}`, path })),
      activeTabId: "t0",
    }));
    if (fontScale) localStorage.setItem("mermark.fontScale", String(fontScale));
  }, { VAULT_ID, NOTES_ID, TAB_PATHS, fontScale });
  await page.goto(url, { waitUntil: "networkidle", timeout: 15000 });
  await page.waitForFunction(() => !!window.__mermark, undefined, { timeout: 8000 });
  await page.waitForTimeout(300);
}

async function openPanel(btnSel, asideSel) {
  await page.evaluate(({ btnSel, asideSel }) => {
    const aside = document.querySelector(asideSel);
    if (aside && aside.hidden) document.querySelector(btnSel)?.click();
  }, { btnSel, asideSel });
  await page.waitForFunction((asideSel) => { const a = document.querySelector(asideSel); return a && !a.hidden; }, asideSel, { timeout: 4000 });
  await page.waitForTimeout(150);
}

/** Geometry of the explorer's Notes folder row (level 1 inside the /mock/vault tree). */
async function measureExplorerFolderRow() {
  await openPanel(".explorer-btn", ".explorer-aside");
  await page.waitForSelector('.explorer-dir[data-path="/mock/vault/notes"] > .explorer-label', { timeout: 6000 });
  return page.evaluate(() => {
    const aside = document.querySelector(".explorer-aside").getBoundingClientRect();
    const label = document.querySelector('.explorer-dir[data-path="/mock/vault/notes"] > .explorer-label');
    const r = label.getBoundingClientRect();
    const rel = (sel) => { const el = label.querySelector(sel); if (!el) return null; const b = el.getBoundingClientRect(); return { left: b.left - r.left, abs: b.left - aside.left, width: b.width, height: b.height }; };
    return { height: r.height, chevron: rel(".explorer-chevron"), glyph: rel(".explorer-glyph"), name: rel(".explorer-name") };
  });
}

/** Geometry of a workspace vault row (same column names). */
async function measureWorkspaceRow(vaultId) {
  await openPanel(".workspace-btn", ".workspace-aside");
  return page.evaluate((vaultId) => {
    const aside = document.querySelector(".workspace-aside").getBoundingClientRect();
    const row = document.querySelector(`.workspace-vault-row[data-vault-id="${vaultId}"]`);
    const r = row.getBoundingClientRect();
    const rel = (sel) => { const el = row.querySelector(sel); if (!el) return null; const b = el.getBoundingClientRect(); return { left: b.left - r.left, abs: b.left - aside.left, width: b.width, height: b.height }; };
    return { height: r.height, chevron: rel(".workspace-vault-chevron"), glyph: rel(".workspace-vault-glyph"), name: rel(".workspace-vault-name") };
  }, vaultId);
}

const near = (a, b, tol = TOL) => a != null && b != null && Math.abs(a - b) <= tol;
const columnsAgree = (ex, ws) =>
  near(ex.height, ws.height) && near(ex.chevron?.left, ws.chevron?.left) && near(ex.glyph?.left, ws.glyph?.left) && near(ex.name?.left, ws.name?.left)
  && near(ex.glyph?.width, ws.glyph?.width) && near(ex.chevron?.width, ws.chevron?.width);

const result = { scenarios: {}, errors };

// ── S1/S2/S4/S5: zoom 1 ──────────────────────────────────────────────────
await page.goto(url, { waitUntil: "networkidle", timeout: 15000 });
await assertPageRendered(page, { context: "sidebar-row-parity-golden" });
await seed(null);
const ex1 = await measureExplorerFolderRow();
const ws1 = await measureWorkspaceRow(VAULT_ID);
await page.screenshot({ path: `${shotBase}.workspace-zoom1.png` });
result.scenarios.S1_columns_zoom1 = {
  explorer: ex1, workspace: ws1,
  // Expected at zoom 1, relative to the row's left edge: chevron 4 / glyph 24 / name 44.
  // Height 28 = the explorer's measured folder row (20px bookmark chip + 2*4 padding);
  // the workspace row takes the same floor via --sidebar-row-control.
  expected: { chevronLeft: 4, glyphLeft: 24, nameLeft: 44, height: 28 },
  agree: columnsAgree(ex1, ws1),
  matchesExpected: near(ws1.chevron?.left, 4) && near(ws1.glyph?.left, 24) && near(ws1.name?.left, 44) && near(ws1.height, ex1.height) && near(ws1.height, 28),
};
const wsChild = await measureWorkspaceRow(NOTES_ID);
result.scenarios.S2_indent_step = {
  parentChevronAbs: ws1.chevron?.abs, childChevronAbs: wsChild.chevron?.abs,
  step: (wsChild.chevron?.abs ?? NaN) - (ws1.chevron?.abs ?? NaN),
  pass: near((wsChild.chevron?.abs ?? NaN) - (ws1.chevron?.abs ?? NaN), 12),
};
result.scenarios.S4_count = await page.evaluate(({ VAULT_ID, NOTES_ID }) => {
  const count = document.querySelector(`.workspace-vault-row[data-vault-id="${VAULT_ID}"] .workspace-vault-count`);
  const notesCount = document.querySelector(`.workspace-vault-row[data-vault-id="${NOTES_ID}"] .workspace-vault-count`);
  const muted = getComputedStyle(document.querySelector(".workspace-aside")).getPropertyValue("--sidebar-muted").trim();
  const cs = count ? getComputedStyle(count) : null;
  // Resolve the muted token to an rgb() string the same way computed color does.
  const probe = document.createElement("span"); probe.style.color = muted; document.body.append(probe);
  const mutedRgb = getComputedStyle(probe).color; probe.remove();
  return { text: count?.textContent ?? null, fontFamily: cs?.fontFamily ?? null, color: cs?.color ?? null, mutedRgb, notesHasCount: !!notesCount };
}, { VAULT_ID, NOTES_ID });
result.scenarios.S4_count.pass = result.scenarios.S4_count.text === "3" && /mono|Menlo|Consolas|Courier/i.test(result.scenarios.S4_count.fontFamily ?? "")
  && result.scenarios.S4_count.color === result.scenarios.S4_count.mutedRgb && !result.scenarios.S4_count.notesHasCount;
result.scenarios.S5_group_label_x = await page.evaluate(() => {
  const aside = document.querySelector(".workspace-aside").getBoundingClientRect();
  const label = document.querySelector(".workspace-group-label");
  const row = document.querySelector(".workspace-vault-group--permanent .workspace-vault-row");
  const range = document.createRange(); range.selectNodeContents(label);
  const textLeft = range.getBoundingClientRect().left - aside.left;
  const chevron = row.querySelector(".workspace-vault-chevron").getBoundingClientRect().left - aside.left;
  return { textLeft, chevronLeft: chevron, pass: Math.abs(textLeft - chevron) <= 0.5 };
});

// ── S3: zoom 1.2 (real persisted SSOT path) ───────────────────────────────
await seed(1.2);
const ex12 = await measureExplorerFolderRow();
const ws12 = await measureWorkspaceRow(VAULT_ID);
await page.screenshot({ path: `${shotBase}.workspace-zoom1.2.png` });
result.scenarios.S3_columns_zoom1_2 = { explorer: ex12, workspace: ws12, agree: columnsAgree(ex12, ws12) };

// ── S6: explorer "열린 파일" view smoke ────────────────────────────────────
await seed(null);
await openPanel(".explorer-btn", ".explorer-aside");
await page.screenshot({ path: `${shotBase}.explorer-tree.png` });
// Tree file row (index.md) columns, to compare with the open-files row below.
await page.waitForSelector('.explorer-file[data-path="/mock/vault/index.md"] > .explorer-label', { timeout: 6000 });
const treeFileRow = await page.evaluate(() => {
  const aside = document.querySelector(".explorer-aside").getBoundingClientRect();
  const label = document.querySelector('.explorer-file[data-path="/mock/vault/index.md"] > .explorer-label');
  const abs = (sel) => label.querySelector(sel).getBoundingClientRect().left - aside.left;
  return { height: label.getBoundingClientRect().height, glyph: abs(".explorer-glyph"), name: abs(".explorer-name") };
});
await page.click('.explorer-view-option[data-view="open-files"]');
await page.waitForSelector(".explorer-open-file", { timeout: 4000 });
const openFileRow = await page.evaluate(() => {
  const aside = document.querySelector(".explorer-aside").getBoundingClientRect();
  const row = document.querySelector('.explorer-open-file-select[data-tab-id="t0"]');
  const abs = (sel) => row.querySelector(sel).getBoundingClientRect().left - aside.left;
  return { height: row.getBoundingClientRect().height, glyph: abs(".explorer-open-file-glyph"), name: abs(".explorer-open-file-name") };
});
// index.md has no folder prefix, so its name column is directly comparable.
result.scenarios.S7_open_files_columns = { treeFileRow, openFileRow, pass: near(treeFileRow.glyph, openFileRow.glyph) && near(treeFileRow.name, openFileRow.name) && near(treeFileRow.height, openFileRow.height) };
const s6a = await page.evaluate(() => {
  const rows = [...document.querySelectorAll(".explorer-open-file")];
  const active = [...document.querySelectorAll('.explorer-open-file-select[data-active="true"]')];
  return { rows: rows.length, active: active.length, activeTitle: active[0]?.getAttribute("title") ?? null, rowHeight: rows[0]?.getBoundingClientRect().height ?? null,
    treeHidden: document.querySelector(".explorer-tree").hidden, refreshHidden: document.querySelector(".explorer-refresh").hidden };
});
await page.screenshot({ path: `${shotBase}.explorer-open-files.png` });
// Switch to t1, then close the INACTIVE t2 (closing the ACTIVE tab falls back to the
// neighbour, which here lives in the Notes sub-vault and would switch vaults).
await page.click(`.explorer-open-file-select[data-tab-id="t1"]`);
await page.waitForFunction(() => document.querySelector('.explorer-open-file-select[data-active="true"]')?.getAttribute("data-tab-id") === "t1", undefined, { timeout: 5000 });
await page.click(`.explorer-open-file:has([data-tab-id="t2"]) .explorer-open-file-close`);
await page.waitForFunction(() => document.querySelectorAll(".explorer-open-file").length === 2, undefined, { timeout: 5000 });
await page.reload({ waitUntil: "networkidle" });
await page.waitForFunction(() => !!window.__mermark, undefined, { timeout: 8000 });
await openPanel(".explorer-btn", ".explorer-aside");
const persisted = await page.evaluate(() => ({ openFilesShown: !document.querySelector(".explorer-open-files").hidden, rows: document.querySelectorAll(".explorer-open-file").length }));
await page.click('.explorer-view-option[data-view="tree"]');
result.scenarios.S6_open_files_view = {
  ...s6a, afterClose: 2, persisted,
  pass: s6a.rows === 3 && s6a.active === 1 && s6a.treeHidden && s6a.refreshHidden && near(s6a.rowHeight, ex1.height) && persisted.openFilesShown && persisted.rows === 2,
};

// Teardown: never leak seeded state into the next golden.
await page.evaluate(() => localStorage.clear());
await page.goto(url, { waitUntil: "networkidle", timeout: 15000 });

result.allPass = result.scenarios.S1_columns_zoom1.agree && result.scenarios.S1_columns_zoom1.matchesExpected
  && result.scenarios.S2_indent_step.pass && result.scenarios.S3_columns_zoom1_2.agree
  && result.scenarios.S4_count.pass && result.scenarios.S5_group_label_x.pass && result.scenarios.S6_open_files_view.pass && result.scenarios.S7_open_files_columns.pass
  && errors.length === 0;

writeFileSync(out, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
console.log("\nwrote", out);
await browser.close();
process.exit(result.allPass ? 0 : 1);
