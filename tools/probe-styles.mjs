/**
 * Read-only style probe: compare the route dock with DSH's native composer docks.
 * Prints geometry and the computed properties that decide the look. No credentials printed.
 */
import { createRequire } from 'node:module';

const require = createRequire(process.env.PLAYWRIGHT_MODULES ?? `${process.cwd()}/`);
const { chromium } = require('playwright-core');
const url = process.env.DSH_VERIFY_URL;
if (!url) throw new Error('Set DSH_VERIFY_URL');

const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), headless: true,
});
const page = await browser.newPage({ viewport: { width: 1380, height: 980 } });
try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.locator('div[data-magpie-route]').waitFor({ timeout: 30000 });
  if (process.env.VERIFY_EXPAND_LIST) {
    const more = page.getByText(/展开其余 \d+ 个会话|Show \d+ more/).first();
    if (await more.count()) { await more.click(); await page.waitForTimeout(800); }
  }
  if (process.env.VERIFY_TITLE) {
    const row = page.getByText(process.env.VERIFY_TITLE, { exact: false }).first();
    await row.waitFor({ timeout: 15000 });
    await row.click();
    await page.waitForTimeout(1500);
  }
  const report = await page.evaluate(() => {
    const props = ['width', 'height', 'marginTop', 'marginBottom', 'paddingTop', 'paddingBottom', 'paddingLeft',
      'borderRadius', 'backgroundColor', 'boxShadow', 'backdropFilter', 'fontSize', 'lineHeight', 'color', 'border'];
    const pick = (el) => {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const out = { tag: el.tagName.toLowerCase(), rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }, cls: (el.className || '').toString().slice(0, 60) };
      for (const p of props) out[p] = cs[p];
      return out;
    };
    const ours = document.querySelector('div[data-magpie-route]');
    // Walk up from a text node to the card that owns the rounded background.
    const cardOf = (text) => {
      const node = [...document.querySelectorAll('div,section,article')]
        .filter((el) => el.textContent?.startsWith(text) && el.getBoundingClientRect().height > 10)
        .sort((a, b) => a.getBoundingClientRect().height - b.getBoundingClientRect().height)[0];
      if (!node) return null;
      let el = node;
      for (let i = 0; i < 4 && el.parentElement; i += 1) {
        if (getComputedStyle(el).borderRadius !== '0px') return pick(el);
        el = el.parentElement;
      }
      return pick(node);
    };
    const dockArea = ours?.closest('[class*="composer"], form, footer') ?? ours?.parentElement;
    // Every rounded card near the composer, so native docks can be compared without guessing text.
    const cards = [...(dockArea?.querySelectorAll('div') ?? [])]
      .filter((el) => {
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return parseFloat(cs.borderRadius) >= 8 && r.height >= 28 && r.height <= 120 && el.children.length > 0;
      })
      .map((el) => ({ ...pick(el), text: (el.textContent ?? '').replace(/\s+/gu, ' ').slice(0, 40) }));
    const seen = new Set();
    const unique = cards.filter((card) => {
      const key = `${card.rect.x}:${card.rect.w}:${card.rect.h}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const root = document.documentElement;
    const vars = {};
    for (const name of ['--dsh-composer-card-max-width', '--dsh-composer-dock-inset', '--dsh-composer-side-clearance', '--dsw-radius-lg']) {
      vars[name] = getComputedStyle(root).getPropertyValue(name).trim() || getComputedStyle(ours).getPropertyValue(name).trim();
    }
    const chain = [];
    for (let el = ours?.parentElement, i = 0; el && i < 5; el = el.parentElement, i += 1) {
      const r = el.getBoundingClientRect();
      chain.push({ cls: (el.className || '').toString().slice(0, 50), w: Math.round(r.width), x: Math.round(r.x), display: getComputedStyle(el).display });
    }
    return {
      vars,
      chain,
      ours: pick(ours),
      todo: cardOf('任务'),
      goal: cardOf('进行中的目标'),
      dockAreaWidth: dockArea ? Math.round(dockArea.getBoundingClientRect().width) : null,
      cards: unique.slice(0, 12),
      inner: [...ours.querySelectorAll('*')].slice(0, 4).map(pick),
    };
  });
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
