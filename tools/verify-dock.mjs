/**
 * Browser acceptance against an existing DSH host (never starts a replacement server).
 * Reads routes and optionally selects an existing workspace/session and expands the dock.
 * Never sends a prompt. Selecting a conversation can mark it read in DSH.
 *
 * DSH_VERIFY_URL=<signed-in URL> PLAYWRIGHT_MODULES=<directory ending in />
 * CHROMIUM_PATH=<executable> node tools/verify-dock.mjs
 * Optional: VERIFY_WORKSPACE, VERIFY_TITLE, VERIFY_SESSION, VERIFY_EXPAND=1,
 * VERIFY_EMPTY=1, VERIFY_INSPECT=1, VERIFY_SCREENSHOT=<output.png>.
 * Do not put credentials in command arguments, screenshots or console output.
 */
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(process.env.PLAYWRIGHT_MODULES ?? `${process.cwd()}/`);
const { chromium } = require('playwright-core');
const url = process.env.DSH_VERIFY_URL;
if (!url) throw new Error('Set DSH_VERIFY_URL to an authenticated DSH URL.');
const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), headless: true,
});
const page = await browser.newPage({ viewport: { width: 1380, height: 980 } });
const readings = [];
page.on('response', (response) => {
  if (!response.url().includes('/plugin/magpie-route/state')) return;
  void response.json().then((data) => { readings.push(data); }).catch(() => {});
});

try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const dock = page.locator('div[data-magpie-route]');
  await dock.waitFor({ timeout: 30000 });
  if (process.env.VERIFY_INSPECT) console.log((await page.locator('body').innerText()).slice(0, 2500));
  if (process.env.VERIFY_WORKSPACE) {
    await page.getByText(process.env.VERIFY_WORKSPACE, { exact: true }).first().click();
  }
  if (process.env.VERIFY_TITLE) {
    await page.getByText(process.env.VERIFY_TITLE, { exact: false }).first().click();
  }
  if (process.env.VERIFY_SESSION) {
    await page.waitForFunction((id) => document.querySelector('div[data-magpie-route]')?.getAttribute('data-route-session') === id, process.env.VERIFY_SESSION, { timeout: 15000 });
  }
  await page.waitForFunction(() => {
    const text = document.querySelector('div[data-magpie-route]')?.textContent ?? '';
    return text && !text.includes('读取本会话路由') && !text.includes('Reading this session');
  }, undefined, { timeout: 15000 });
  const before = await dock.innerText();
  const selected = await dock.getAttribute('data-route-session');
  assert.ok(selected && selected !== '[object Object]');
  // Bounded observation of two UI poll cycles, not a background-job polling loop.
  await page.waitForTimeout(4500);
  const after = await dock.innerText();
  const relevant = readings.filter((data) => data.ok && data.sessionId === selected);
  assert.ok(relevant.length > 0, 'No verified payload for the selected session');
  for (const data of relevant) {
    assert.equal(data.attribution, 'explicit-token');
    assert.ok(data.routes.every((route) => route.sessionId === selected));
    for (const child of data.agents ?? []) assert.ok(child.routes.every((route) => route.sessionId === child.sessionId));
  }
  if (process.env.VERIFY_EMPTY) {
    assert.ok(relevant.every((data) => data.routes.length === 0));
    assert.equal(after, before, 'Unqueried session dock changed while other agents ran');
  }
  if (process.env.VERIFY_EXPAND) await dock.locator('button').first().click();
  console.log(JSON.stringify({ sessionId: selected, stable: before === after, polls: relevant.length,
    mainRouteIds: relevant.at(-1).routes.map((route) => route.id),
    children: (relevant.at(-1).agents ?? []).map((child) => ({ sessionId: child.sessionId, label: child.label, routeIds: child.routes.map((route) => route.id) })),
    dockText: (await dock.innerText()).replace(/\s+/gu, ' ').trim(),
  }, null, 2));
  if (process.env.VERIFY_SCREENSHOT) {
    await dock.screenshot({ path: process.env.VERIFY_SCREENSHOT });
    console.log('Saved dock-only screenshot.');
  }
} catch (error) {
  // Playwright's navigation error can include the tokenized URL; report only a safe summary.
  console.error('Browser acceptance failed:', error?.name ?? 'Error');
  process.exitCode = 1;
} finally {
  await browser.close();
}
