// Deploy the web app + API to Vercel from a git-free snapshot.
// Why: when the CLI runs inside a git repo it attaches commit metadata, and on the
// Hobby plan Vercel BLOCKS deployments whose commit author is not a member of the
// Vercel account. A snapshot without .git avoids that and never uploads secrets.
//   npm run deploy:web
import { execSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ROOT } from '../lib/near.js';

const SKIP = new Set(['node_modules', '.git', '.keys', '.env', 'media', 'out', '.gstack', '.claude']);
execSync('npx vite build web', { cwd: ROOT, stdio: 'inherit' });
const dir = mkdtempSync(path.join(tmpdir(), 'antrepreneur-deploy-'));
try {
  cpSync(ROOT, dir, { recursive: true, filter: (src) => !SKIP.has(path.relative(ROOT, src).split(path.sep)[0]) });
  execSync('vercel deploy --prod --yes', { cwd: dir, stdio: 'inherit' });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
