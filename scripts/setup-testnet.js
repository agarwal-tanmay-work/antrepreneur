// Creates fresh testnet accounts via the public faucet and writes .env.
//   ant-<rand>.testnet       -> the Antrepreneur contract
//   ant-ops-<rand>.testnet   -> owner (registers attested TEE keys)
//   poster.ant-ops-...       -> demo poster / backer / relayer
//   treasury.ant-ops-...     -> inference treasury
// Also generates ANT_AGENT_SEED (ant function-call keys derive from it).
import { randomBytes } from 'node:crypto';
import { KeyPair } from 'near-api-js';
import { faucetCreate, setEnv, account, toYocto, saveKey } from '../lib/near.js';

const tag = Math.random().toString(36).slice(2, 7);
const contract = `ant-${tag}.testnet`;
const ops = `ant-ops-${tag}.testnet`;
const funders = [`ant-fund-${tag}.testnet`, `ant-fund2-${tag}.testnet`];
console.log('Creating accounts with the testnet faucet...');
for (const id of [contract, ops, ...funders]) { await faucetCreate(id); console.log('  created', id); }
await new Promise((r) => setTimeout(r, 3000));
const o = account(ops);
const subs = {};
for (const [name, amount] of [['poster', 6], ['treasury', 0.5]]) {
  const kp = KeyPair.fromRandom('ed25519');
  const id = `${name}.${ops}`;
  await o.createAccount({ newAccountId: id, publicKey: kp.getPublicKey().toString(), nearToTransfer: toYocto(amount) });
  saveKey(id, kp);
  subs[name] = id;
  console.log('  created', id);
}
for (const f of funders) {
  const a = account(f);
  await a.transfer({ receiverId: subs.poster, amount: (await a.getBalance()) - toYocto(0.1) });
}
setEnv({
  NEAR_NETWORK: 'testnet', ANT_CONTRACT: contract, ANT_OPS: ops, ANT_POSTER: subs.poster, ANT_RELAYER: subs.poster,
  ANT_TREASURY: subs.treasury, ANT_AGENT_SEED: randomBytes(32).toString('hex'),
});
console.log('\nWrote .env. Next: npm run build:contract && npm run deploy');
