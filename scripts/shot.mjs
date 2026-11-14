// Screenshot helper for README/demo media:  node scripts/shot.mjs <url> <out.png> [width] [height] [selector-to-click]
import { chromium } from 'playwright';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
export function chromePath() {
  const base = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  if (!existsSync(base)) return undefined;
  for (const d of readdirSync(base).filter((x) => /^chromium-\d+$/.test(x)).sort().reverse()) {
    const sub = readdirSync(path.join(base, d)).find((x) => x.startsWith('chrome-win'));
    if (sub && existsSync(path.join(base, d, sub, 'chrome.exe'))) return path.join(base, d, sub, 'chrome.exe');
  }
}
if (process.argv[1].endsWith('shot.mjs')) {
  const [url, out, w = 1440, h = 900, click] = process.argv.slice(2);
  const b = await chromium.launch({ executablePath: chromePath() });
  const p = await b.newPage({ viewport: { width: Number(w), height: Number(h) }, deviceScaleFactor: 2 });
  await p.goto(url, { waitUntil: 'networkidle' }); await p.waitForTimeout(2500);
  if (click) { await p.click(click); await p.waitForTimeout(1500); }
  await p.screenshot({ path: out }); await b.close();
}
