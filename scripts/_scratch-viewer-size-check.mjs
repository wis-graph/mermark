import { chromium } from "playwright";

const url = "http://localhost:1430/?file=/mock/vault/index.md";
const ver = await (await fetch("http://127.0.0.1:9222/json/version")).json();
const browser = await chromium.connectOverCDP(ver.webSocketDebuggerUrl);
const ctx = browser.contexts()[0] ?? (await browser.newContext());
const page = ctx.pages()[0] ?? (await ctx.newPage());

const rowFor = (path) => page.locator(`.explorer-item[data-path="${path}"]`);

async function checkAt(width, height, tag) {
  await page.setViewportSize({ width, height });
  await page.goto(url, { waitUntil: "networkidle", timeout: 15000 });
  await page.waitForTimeout(500);
  await page.click(".explorer-btn");
  await page.waitForTimeout(200);

  // Excel
  await rowFor("/mock/vault/report.xlsx").click();
  await page.waitForTimeout(700);
  const excel = await page.locator(".excel-viewer").evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { w: r.width, h: r.height };
  });
  await page.screenshot({ path: `/tmp/viewer-size-${tag}-excel.png` });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);

  // HWP
  await rowFor("/mock/vault/sample.hwp").click();
  await page.waitForTimeout(600);
  const hwp = await page.locator(".hwp-viewer").evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { w: r.width, h: r.height };
  });
  const page0 = await page
    .locator('.hwp-viewer-page[data-page="0"]')
    .evaluate((el) => el.getBoundingClientRect().width)
    .catch(() => null);
  await page.screenshot({ path: `/tmp/viewer-size-${tag}-hwp.png` });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);

  console.log(tag, { width, height, excel, excelRatio: excel.w / width, hwp, hwpRatio: hwp.w / width, hwpPage0Width: page0 });
}

await checkAt(1280, 900, "1280");
await checkAt(3840, 2160, "4k");

await page.setViewportSize({ width: 1280, height: 900 });
await browser.close();
