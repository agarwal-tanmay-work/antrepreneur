// Long-running runner: ants work, reviewer awards, keeper buries.
//   npm run runner
import { tick, status } from './core.js';
const every = Number(process.env.RUNNER_INTERVAL_SEC || 8) * 1000;
console.log('Antrepreneur runner', status());
for (;;) {
  try { await tick(); } catch (e) { console.error('tick error:', e.message); }
  await new Promise((r) => setTimeout(r, every));
}
