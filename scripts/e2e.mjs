// End-to-end test of the web app in a real browser (Playwright + Chromium).
//   node scripts/e2e.mjs                         (local: http://localhost:3000)
//   E2E_URL=https://antrepreneur.vercel.app node scripts/e2e.mjs
//   node scripts/e2e.mjs --write                 (also posts a real testnet job)
// Screenshots land in media/e2e/. Exits 1 on any failure.
import { chromium } from 'playwright';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const URL = process.env.E2E_URL || 'http://localhost:3000';
const OUT = path.join(ROOT, 'media', 'e2e');
mkdirSync(OUT, { recursive: true });
const WRITE = process.argv.includes('--write');

function chromePath() {
  const base = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  if (!existsSync(base)) return undefined;
  for (const d of readdirSync(base).filter((x) => /^chromium-\d+$/.test(x)).sort().reverse()) {
    const sub = readdirSync(path.join(base, d)).find((x) => x.startsWith('chrome-win'));
    if (sub && existsSync(path.join(base, d, sub, 'chrome.exe'))) return path.join(base, d, sub, 'chrome.exe');
  }
  return undefined;
}

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };

const browser = await chromium.launch({ executablePath: chromePath() });
try {
  for (const vp of [{ name: 'desktop', width: 1440, height: 900 }, { name: 'tablet', width: 820, height: 1180 }, { name: 'phone', width: 390, height: 844 }]) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, reducedMotion: 'no-preference' });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test(m.text())) errors.push(m.text()); });
    await page.goto(URL, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForSelector('.farm svg .chamber', { timeout: 60000 });
    await page.waitForTimeout(1500);
    const tag = `[${vp.name}]`;

    check(`${tag} hero headline names the product`, (await page.locator('h1').innerText()).includes('AI workers'));
    const chambers = await page.locator('.farm .chamber').count();
    const ants = await page.locator('.farm .ant').count();
    check(`${tag} colony draws one chamber and one ant per agent`, chambers > 0 && chambers === ants, `${chambers} chambers, ${ants} ants`);
    const dropBtn = page.getByRole('button', { name: /Drop job in/ });
    const box = await dropBtn.boundingBox();
    check(`${tag} primary action is visible`, Boolean(box), box ? `y=${Math.round(box.y)}` : 'missing');
    if (vp.name === 'desktop') check(`${tag} primary action sits inside the first screen`, box && box.y + box.height <= vp.height, `bottom=${Math.round(box.y + box.height)} of ${vp.height}`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(`${tag} no sideways scroll`, overflow <= 1, `${overflow}px`);
    for (const id of ['colony', 'jobs', 'simulation', 'trust']) check(`${tag} section #${id} renders`, (await page.locator(`#${id} h2`).count()) === 1);
    await page.screenshot({ path: path.join(OUT, `${vp.name}-first-screen.png`) });
    await page.screenshot({ path: path.join(OUT, `${vp.name}-full.png`), fullPage: true });

    // ledger row expands to show the on-chain persona
    await page.locator('#colony tr.row').first().click();
    check(`${tag} ant row expands with its persona`, await page.locator('#colony .persona').first().isVisible());

    // job drawer with verdict proof
    const jobs = page.locator('#jobs .job');
    if (await jobs.count()) {
      await jobs.first().click();
      await page.waitForSelector('.drawer[data-open="true"] .answer', { timeout: 20000 }).catch(() => {});
      check(`${tag} job drawer opens with answers`, (await page.locator('.drawer[data-open="true"] .answer').count()) > 0);
      if (vp.name === 'desktop') await page.screenshot({ path: path.join(OUT, `${vp.name}-job-drawer.png`) });
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
      check(`${tag} drawer closes with Escape`, (await page.locator('.drawer[data-open="true"]').count()) === 0);
    }

    // trust: live attestation renders
    await page.locator('#trust').scrollIntoViewIfNeeded();
    await page.waitForSelector('#trust .att', { timeout: 60000 }).catch(() => {});
    const verified = await page.locator('#trust .ok-pill').count();
    check(`${tag} live TEE attestation shows verified models`, verified > 0, `${verified} verified`);
    if (vp.name === 'desktop') await page.screenshot({ path: path.join(OUT, `${vp.name}-trust.png`) });

    // keyboard: skip to content via Tab reaches the wordmark first
    await page.keyboard.press('Home');
    check(`${tag} no console errors`, errors.length === 0, errors.slice(0, 2).join(' | '));
    await ctx.close();
  }

  if (WRITE) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(URL, { waitUntil: 'networkidle' });
    await page.fill('#task', 'In one sentence, what is a function-call access key on NEAR? (e2e test)');
    await page.getByRole('button', { name: /Drop job in/ }).click();
    await page.waitForSelector('.toast', { timeout: 30000 });
    check('[write] posting a job shows a confirmation with a transaction link', (await page.locator('.toast a').count()) > 0, await page.locator('.toast').innerText());
    await ctx.close();
  }
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed. Screenshots: media/e2e/`);
process.exit(failed.length ? 1 : 0);
