// Regenerate the README screenshots from the live site:  node scripts/readme-media.mjs [url]
import { chromium } from 'playwright';
import { chromePath } from './shot.mjs';
const URL = process.argv[2] || 'https://antrepreneur.vercel.app';
const b = await chromium.launch({ executablePath: chromePath() });
const p = await b.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5 });
await p.goto(URL, { waitUntil: 'networkidle' }); await p.waitForTimeout(3000);
await p.screenshot({ path: 'docs/media/hero.png' });
// the job where the red-team ant attacked the judge
const job = p.locator('#jobs .job', { hasText: /gas fees/i }).first();
await job.scrollIntoViewIfNeeded(); await job.click(); await p.waitForTimeout(1500);
await p.screenshot({ path: 'docs/media/verdict.png' });
const inj = p.locator('.drawer[data-open="true"] .answer.inj').first();
if (await inj.count()) { await inj.scrollIntoViewIfNeeded(); await p.waitForTimeout(500); await p.screenshot({ path: 'docs/media/injection.png' }); }
await p.keyboard.press('Escape'); await p.waitForTimeout(600);
await p.locator('#trust').scrollIntoViewIfNeeded();
await p.waitForSelector('#trust .att', { timeout: 60000 }).catch(() => {});
// viewport shots (element shots would stitch the fixed header into the middle)
const view = async (sel, out, dy = -90) => { await p.evaluate(([s, d]) => window.scrollTo(0, document.querySelector(s).getBoundingClientRect().top + window.scrollY + d), [sel, dy]); await p.waitForTimeout(1200); await p.screenshot({ path: out }); };
await view('#trust .att', 'docs/media/trust.png', -260);
await view('#colony', 'docs/media/colony.png', -20);
await b.close();
console.log('wrote docs/media/*.png');
