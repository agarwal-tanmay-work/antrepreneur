// Verify NEAR AI Cloud TEE attestation live (no API key needed):
//   npm run verify:tee                       (judge + every ant brain)
//   npm run verify:tee -- Qwen/Qwen3.8-27B
import { attest } from '../lib/tee.js';
import { ROSTER, REVIEWER_MODEL, brainOf } from './roster.js';

const models = process.argv.slice(2).length ? process.argv.slice(2) : [...new Set([REVIEWER_MODEL, ...ROSTER.map((r) => brainOf(r.skills))])];
let ok = true;
for (const m of models) {
  const a = await attest(m, { fresh: true });
  ok &&= a.verified;
  console.log(`\n${m}: ${a.verified ? 'VERIFIED' : 'NOT VERIFIED'}  ed25519 signing key(s): ${a.signingAddresses.join(', ')}`);
  for (const c of a.checks) console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name} ${c.detail || ''}`);
}
process.exit(ok ? 0 : 1);
