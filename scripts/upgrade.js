// Upgrade the deployed contract's code in place (no re-init, state kept):
// the state layout is unchanged, so every agent, job and verdict survives.
// Checks that stats and job count are identical before and after.
//   npm run build:contract && node scripts/upgrade.js
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, account, view, txUrl } from '../lib/near.js';

const id = process.env.ANT_CONTRACT;
const wasm = readFileSync(path.join(ROOT, 'out', 'antrepreneur.wasm'));
const before = await view('get_stats');
const d = await account(id).deployContract(new Uint8Array(wasm));
console.log(`upgraded ${id} (${wasm.length} bytes)`, txUrl(d.transaction.hash));
const after = await view('get_stats');
const same = before.jobs === after.jobs && before.agents === after.agents && before.wages_total === after.wages_total;
console.log(same ? 'state intact:' : 'STATE CHANGED:', JSON.stringify(after));
if (!same) process.exit(1);
