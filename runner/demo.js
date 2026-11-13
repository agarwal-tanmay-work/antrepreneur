// One-command demo on testnet (v2):
//  1. spawns the colony (Scout, Quill, Ledger, Drifter, Trojan)
//  2. a backer buys shares in two ants
//  3. posts N jobs (2-minute deadline) with escrowed rewards
//  4. ants answer on TEE models and store answers on chain from their own keys
//  5. after the deadline the judge's signed verdict is relayed; the CONTRACT
//     verifies the signature and the exact judge input, then pays the winner
//  6. proves an ant key cannot move money; prints the colony
//   npm run demo            npm run demo -- --jobs 3
import { seedRoster, workerTick, reviewerTick, keeperTick, status } from './core.js';
import { call, view, toYocto, fromYocto, txUrl, account } from '../lib/near.js';
import { SAMPLE_JOBS } from './roster.js';

const args = process.argv.slice(2);
const N = Number(args[args.indexOf('--jobs') + 1] || 2) || 2;
const POSTER = process.env.ANT_POSTER;
console.log('status', status());
if (!status().online) console.log('\n!! No NEARAI_CLOUD_API_KEY: ants use the labelled OFFLINE brain, and verdicts are signed by a registered DEV key (NOT a TEE).\n');

await seedRoster();
for (const h of ['scout', 'quill']) {
  const q = await view('quote_buy', { handle: h, shares: '5' });
  const r = await call(POSTER, 'buy', { handle: h, shares: '5' }, { deposit: BigInt(q.total) + toYocto(0.01) });
  console.log(`[buy] backer bought 5 ${h} for ${fromYocto(q.total)} NEAR  ${txUrl(r.hash)}`);
}
const start = (Date.now() / 60000) | 0;
for (let i = 0; i < N; i++) {
  const j = SAMPLE_JOBS[(start + i) % SAMPLE_JOBS.length];
  const r = await call(POSTER, 'post_job', { title: j.title, spec: j.spec, duration_minutes: 2 }, { deposit: toYocto(j.reward + 0.03) });
  console.log(`[job] #${r.result} "${j.title}" ~${j.reward} NEAR in escrow  ${txUrl(r.hash)}`);
}
await workerTick();
console.log('\n...waiting for the 2-minute deadline, then relaying the judge verdict...');
for (let k = 0; k < 30; k++) {
  await new Promise((r) => setTimeout(r, 6000));
  await workerTick({ quiet: true }); // catch jobs the first pass missed (view lag)
  const open = (await view('list_jobs', { from_index: 0, limit: N })).filter((j) => j.status === 'Open');
  if (open.some((j) => j.reviewable)) await reviewerTick();
  if (!open.length) break;
}
await keeperTick();

// key-safety proof: an ant's own key tries to send NEAR away
try {
  await account(`scout.${process.env.ANT_CONTRACT}`).transfer({ receiverId: POSTER, amount: toYocto(0.01) });
  console.log('!! transfer succeeded (BAD)');
} catch (e) {
  console.log(`\n[safety] the scout key tried to transfer NEAR and the protocol rejected it: ${String(e.message).slice(0, 60)}`);
}

console.log('\nCOLONY');
for (const a of await view('list_agents', { from_index: 0, limit: 50 })) {
  console.log(`  ${a.handle.padEnd(9)} ${a.alive ? 'alive' : 'DEAD '} wins ${String(a.wins).padStart(2)}  price ${fromYocto(a.spot_price)}  backing/sh ${fromYocto(a.backing_per_share)} (+${fromYocto(a.pending)} vesting)  food ${fromYocto(a.budget)}`);
}
console.log('stats', await view('get_stats'));
