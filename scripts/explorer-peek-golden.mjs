// CDP Golden Master for the explorer's two modes — pinned vs edge-hover peek
// (_workspace/01_architect_design.md / 01_architect_plan.md, scenarios G0–G14).
//
//   node scripts/explorer-peek-golden.mjs /tmp/explorer-peek.json
//
// Assumes `npm run dev:browser` (:1430) + chrome-headless-shell
// --remote-debugging-port=9222. Pointer input is ALWAYS page.mouse.* (CDP Input
// = real pointermove/buttons), never dispatchEvent. Focus emulation is
// mandatory: headless otherwise reports document.hasFocus() === false and the
// controller (correctly) refuses to peek — a false G2/G3 failure.
import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertPageRendered } from "./lib/preflight.mjs";

const out = process.argv[2] ?? "/tmp/explorer-peek.json";
const URL_ = process.argv[3] ?? "http://localhost:1430/?file=/mock/vault/index.md";
const SHOTS = process.env.SHOT_DIR ?? resolve(dirname(fileURLToPath(import.meta.url)), "../_workspace/shots");
mkdirSync(SHOTS, { recursive: true });

const CDP_PORT = process.env.CDP_PORT ?? "9222";
const ver = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
const browser = await chromium.connectOverCDP(ver.webSocketDebuggerUrl);
const ctx = browser.contexts()[0] ?? (await browser.newContext());
const page = ctx.pages()[0] ?? (await ctx.newPage());
const cdp = await ctx.newCDPSession(page);

const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });

const results = [];
const check = (id, name, pass, detail) => {
  results.push({ id, name, pass: !!pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${id} ${name}${pass ? "" : "  " + JSON.stringify(detail)}`);
};

async function load(url = URL_) {
  await page.setViewportSize({ width: 1200, height: 900 });
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await page.bringToFront();
  await page.goto(url);
  await page.waitForTimeout(800);
  await page.mouse.move(600, 400); // park the pointer in the editor, outside the strip
}
await load();
const focused = await page.evaluate(() => document.hasFocus());
if (!focused) {
  console.error("infra: document.hasFocus() is false even with focus emulation — aborting");
  process.exit(2);
}
await assertPageRendered(page, { context: "explorer-peek-golden" });

const snap = () => page.evaluate(() => {
  const r = (s) => document.querySelector(s)?.getBoundingClientRect();
  const aside = document.querySelector(".explorer-aside");
  const grp = document.querySelector(".left-command-group");
  const ae = document.activeElement;
  return {
    mainW: r(".main-column")?.width,
    cmW: r(".cm-content")?.width,
    grp: grp ? { x: grp.getBoundingClientRect().x, y: grp.getBoundingClientRect().y, parent: grp.parentElement?.className } : null,
    barPad: getComputedStyle(document.querySelector(".title-bar")).paddingLeft,
    sash: getComputedStyle(document.querySelector(".workspace-sash")).display,
    hidden: aside.hidden,
    peek: aside.hasAttribute("data-peek"),
    pos: getComputedStyle(aside).position,
    top: aside.getBoundingClientRect().top,
    active: ae ? ae.tagName + "." + ae.className : null,
    docName: document.querySelector(".title-bar-doc-name")?.textContent,
    dock: aside.querySelector(".explorer-dock-btn")?.getAttribute("aria-label"),
    anyOtherOpen: [...document.querySelectorAll(".sidebar-aside")].some((a) => a !== aside && !a.hidden),
  };
});
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const approx = (a, b) => Math.abs(a - b) < 0.5;

const enterStrip = async (y = 400) => {
  await page.mouse.move(600, y);
  await page.mouse.move(3, y);
};
const waitPeek = async () => {
  await enterStrip();
  await page.waitForTimeout(300);
};

// G0
const base = await snap();
check("G0", "baseline: explorer hidden", base.hidden && !base.peek, base);
await page.screenshot({ path: `${SHOTS}/peek-closed.png` });

// G1
await page.mouse.move(3, 12);
await page.waitForTimeout(400);
check("G1", "title-bar band does not trigger", (await snap()).hidden, null);

// G2
await page.mouse.move(400, 400);
await page.mouse.move(3, 400);
await page.waitForTimeout(100);
check("G2", "no peek before dwell", (await snap()).hidden, null);

// G3
await page.waitForTimeout(200);
let s = await snap();
check("G3", "peek after dwell: fixed overlay, layout untouched, focus kept",
  !s.hidden && s.peek && s.pos === "fixed" && approx(s.top, 36)
  && approx(s.mainW, base.mainW) && approx(s.cmW, base.cmW)
  && eq(s.grp, base.grp) && s.barPad === base.barPad && s.sash === "none" && s.active === base.active,
  { s, base });
await page.screenshot({ path: `${SHOTS}/peek-open.png` });

// G4
await page.mouse.move(120, 400);
await page.waitForTimeout(600);
check("G4", "stays open while pointer is inside", !(await snap()).hidden, null);

// G5
await page.mouse.move(700, 400);
await page.waitForTimeout(150);
const still = !(await snap()).hidden;
await page.waitForTimeout(300);
s = await snap();
check("G5", "closes after leave grace; main width unchanged", still && s.hidden && approx(s.mainW, base.mainW), { still, s });

// G6
await page.mouse.move(600, 400);
await page.mouse.down();
await page.mouse.move(3, 400);
await page.waitForTimeout(400);
const g6 = (await snap()).hidden;
await page.mouse.up();
check("G6", "no peek when entering with button held", g6, null);
await page.mouse.move(600, 400);

// G7
await waitPeek();
let g7a = !(await snap()).hidden;
await page.keyboard.press("Escape");
await page.waitForTimeout(50);
const g7b = (await snap()).hidden;
await page.mouse.move(4, 401);
await page.waitForTimeout(500);
const g7c = (await snap()).hidden;
await page.mouse.move(50, 400);
await page.mouse.move(3, 400);
await page.waitForTimeout(300);
const g7d = !(await snap()).hidden;
check("G7", "Esc closes; no reopen until re-armed; re-arm reopens", g7a && g7b && g7c && g7d, { g7a, g7b, g7c, g7d });

// G8: expand a folder while peeking, then pin via the toggle button
await page.mouse.move(120, 200);
await page.click('.explorer-aside .explorer-item.explorer-dir[data-path="/mock/vault/notes"]');
await page.waitForTimeout(300);
const expanded = await page.evaluate(() =>
  document.querySelector('.explorer-aside .explorer-dir[data-path="/mock/vault/notes"]')?.getAttribute("aria-expanded"));
await page.click(".explorer-btn");
await page.waitForTimeout(300);
s = await snap();
const expandedAfter = await page.evaluate(() =>
  document.querySelector('.explorer-aside .explorer-dir[data-path="/mock/vault/notes"]')?.getAttribute("aria-expanded"));
const sidebarW = await page.evaluate(() => document.querySelector(".explorer-aside").getBoundingClientRect().width);
check("G8", "peek -> pinned via toggle button: layout reflows, no re-render",
  !s.hidden && !s.peek && expanded === "true" && expandedAfter === "true"
  && s.mainW < base.mainW - sidebarW + 1 && s.grp.parent.includes("sidebar-top-strip") && s.sash === "block",
  { s, expanded, expandedAfter, sidebarW, baseMain: base.mainW });
await page.mouse.move(900, 400);
await page.waitForTimeout(600);
check("G8b", "pinned does not close on hover-out", !(await snap()).hidden, null);
await page.screenshot({ path: `${SHOTS}/peek-pinned.png` });

// G9: collapse via header «
const g9label = (await snap()).dock;
await page.click(".explorer-dock-btn");
await page.waitForTimeout(300);
s = await snap();
check("G9", "dock « collapses; layout back to baseline",
  g9label === "사이드바 접기" && s.hidden && approx(s.mainW, base.mainW) && s.grp.parent === base.grp.parent && eq(s.grp, base.grp),
  { g9label, s, base });

// G10: re-peek, » pins, « closes
await page.mouse.move(600, 400);
await waitPeek();
const g10label = (await snap()).dock;
await page.click(".explorer-dock-btn");
await page.waitForTimeout(300);
s = await snap();
const g10pinned = !s.hidden && !s.peek && s.mainW < base.mainW && s.grp.parent.includes("sidebar-top-strip") && s.dock === "사이드바 접기";
await page.click(".explorer-dock-btn");
await page.waitForTimeout(300);
check("G10", "dock » pins a peek; « closes it again", g10label === "사이드바 고정" && g10pinned && (await snap()).hidden, { g10label, g10pinned });

// G11: opening a file dismisses the peek
await page.mouse.move(600, 400);
await waitPeek();
const nameBefore = (await snap()).docName;
await page.click('.explorer-aside .explorer-item[data-path="/mock/vault/plain.txt"]');
await page.waitForTimeout(500);
s = await snap();
check("G11", "file open closes peek and switches document", s.hidden && s.docName !== nameBefore, { nameBefore, after: s.docName, hidden: s.hidden });

// G12: outside click closes immediately
await page.mouse.move(600, 400);
await waitPeek();
await page.mouse.click(700, 400);
await page.waitForTimeout(50);
check("G12", "outside click closes within 50ms", (await snap()).hidden, null);

// G13: other panel open -> edge hover ignored
await page.mouse.move(600, 400);
await page.click(".outline-btn");
await page.waitForTimeout(200);
await page.mouse.move(600, 400);
await page.mouse.move(3, 400);
await page.waitForTimeout(400);
s = await snap();
const outlineOpen = await page.evaluate(() => { const a = document.querySelector(".outline-aside"); return !!a && !a.hidden; });
check("G13", "ignored while another panel is open", s.hidden && outlineOpen, { s, outlineOpen });
await page.click(".outline-btn");
await page.waitForTimeout(200);

// G14: setting off
await page.evaluate(() => localStorage.setItem("mermark.explorerEdgePeek", "off"));
await load();
await page.mouse.move(3, 400);
await page.waitForTimeout(400);
check("G14", "setting off: no peek", (await snap()).hidden, null);
await page.evaluate(() => localStorage.removeItem("mermark.explorerEdgePeek"));
await load();

// Dark-theme screenshot of a peek (visual review only).
await page.evaluate(() => localStorage.setItem("mermark.theme", "dark"));
await load();
await waitPeek();
await page.screenshot({ path: `${SHOTS}/peek-open-dark.png` });
await page.evaluate(() => localStorage.removeItem("mermark.theme"));
await load();

check("ERR", "no pageerror / console.error", errors.length === 0, errors);

writeFileSync(out, JSON.stringify({ results, errors }, null, 2));
const failed = results.filter((r) => !r.pass);
console.log(failed.length ? `\n${failed.length} FAILED` : "\nALL PASS");
await browser.close();
process.exit(failed.length ? 1 : 0);
