// Shared NEAR helpers for scripts, runner and web API (near-api-js v7).
import { Account, FailoverRpcProvider, JsonRpcProvider, KeyPair } from 'near-api-js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import './env.js';
import { antKeyPair } from './keys.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const KEYS_DIR = process.env.ANT_KEYS_DIR || path.join(ROOT, '.keys');
export const NETWORK = process.env.NEAR_NETWORK || 'testnet';
export const RPC_URL = process.env.NEAR_RPC_URL || (NETWORK === 'mainnet' ? 'https://rpc.mainnet.fastnear.com' : 'https://rpc.testnet.fastnear.com');
// several public RPCs: if one rate-limits (429) or fails, the next takes over
const RPC_URLS = process.env.NEAR_RPC_URL ? [process.env.NEAR_RPC_URL] : NETWORK === 'mainnet'
  ? ['https://rpc.mainnet.fastnear.com', 'https://free.rpc.fastnear.com', 'https://rpc.mainnet.near.org']
  : ['https://rpc.testnet.fastnear.com', 'https://test.rpc.fastnear.com', 'https://rpc.testnet.near.org'];
export const provider = new FailoverRpcProvider(RPC_URLS.map((url) => new JsonRpcProvider({ url })));
export const CONTRACT_ID = process.env.ANT_CONTRACT;
export const EXPLORER = NETWORK === 'mainnet' ? 'https://nearblocks.io' : 'https://testnet.nearblocks.io';
export const txUrl = (hash) => `${EXPLORER}/txns/${hash}`;

export const NEAR = 10n ** 24n;
export const toYocto = (near) => BigInt(Math.round(Number(near) * 1e6)) * 10n ** 18n;
export const fromYocto = (y, d = 4) => (Number(BigInt(y)) / 1e24).toFixed(d);

export function saveKey(accountId, keyPair) {
  mkdirSync(KEYS_DIR, { recursive: true });
  writeFileSync(path.join(KEYS_DIR, `${accountId}.json`), JSON.stringify({ account_id: accountId, public_key: keyPair.getPublicKey().toString(), private_key: keyPair.toString() }, null, 1));
}
/** Key lookup: ant sub-accounts are derived from ANT_AGENT_SEED; other accounts
 *  come from ANT_KEYS_JSON (hosted) or .keys/<account>.json (local). */
export function loadKey(accountId) {
  const contract = process.env.ANT_CONTRACT;
  if (contract && accountId.endsWith(`.${contract}`) && process.env.ANT_AGENT_SEED) {
    return antKeyPair(accountId.slice(0, -(contract.length + 1)), contract).toString();
  }
  if (process.env.ANT_KEYS_JSON) {
    const m = JSON.parse(process.env.ANT_KEYS_JSON);
    if (m[accountId]) return m[accountId];
  }
  const f = path.join(KEYS_DIR, `${accountId}.json`);
  if (existsSync(f)) return JSON.parse(readFileSync(f, 'utf8')).private_key;
  throw new Error(`No key for ${accountId}`);
}
export const account = (accountId) => new Account(accountId, provider, loadKey(accountId));

export async function view(method, args = {}, contractId = CONTRACT_ID || process.env.ANT_CONTRACT) {
  return provider.callFunction({ contractId, method, args, blockQuery: { finality: 'optimistic' } });
}

// one in-flight transaction per signer, so concurrent calls never race on the nonce
const queues = new Map();
export async function call(signerId, method, args = {}, { deposit = 0n, gas = 100n * 10n ** 12n, contractId = CONTRACT_ID || process.env.ANT_CONTRACT, waitUntil } = {}) {
  const prev = queues.get(signerId) || Promise.resolve();
  const run = prev.catch(() => {}).then(async () => {
    const acc = account(signerId);
    const res = await acc.callFunctionRaw({ contractId, methodName: method, args, deposit, gas, ...(waitUntil ? { waitUntil } : {}) });
    return { hash: res.transaction?.hash ?? res.transaction_outcome?.id, result: decodeResult(res), raw: res };
  });
  queues.set(signerId, run);
  return run;
}

export function decodeResult(res) {
  const sv = res?.status?.SuccessValue;
  if (sv === undefined || sv === '') return null;
  try { return JSON.parse(Buffer.from(sv, 'base64').toString()); } catch { return null; }
}

export async function faucetCreate(accountId) {
  const kp = KeyPair.fromRandom('ed25519');
  let last;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const r = await fetch('https://helper.nearprotocol.com/account', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newAccountId: accountId, newAccountPublicKey: kp.getPublicKey().toString() }),
      });
      if (!r.ok) throw new Error(`faucet ${r.status}: ${(await r.text()).slice(0, 200)}`);
      saveKey(accountId, kp);
      return kp;
    } catch (e) {
      last = e;
      await new Promise((res) => setTimeout(res, 3000 * attempt));
    }
  }
  throw last;
}

export function setEnv(updates) {
  const f = path.join(ROOT, '.env');
  let text = existsSync(f) ? readFileSync(f, 'utf8') : '';
  for (const [k, v] of Object.entries(updates)) {
    const re = new RegExp(`^${k}=.*$`, 'm');
    text = re.test(text) ? text.replace(re, `${k}=${v}`) : `${text}${text && !text.endsWith('\n') ? '\n' : ''}${k}=${v}\n`;
    process.env[k] = v;
  }
  writeFileSync(f, text);
}
