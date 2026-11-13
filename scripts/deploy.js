// Deploys out/antrepreneur.wasm to ANT_CONTRACT and initializes it with the judge
// model + judge prompt (immutable). Then registers the judge's TEE signing keys,
// but only after their Intel TDX + NVIDIA attestation verifies. Without a NEAR AI
// Cloud API key it also registers a DEV key, recorded on chain as DEV-KEY-NOT-TEE.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, account, view, call, txUrl, fromYocto } from '../lib/near.js';
import { REVIEWER_MODEL, REVIEW_PROMPT } from '../runner/roster.js';
import { attest, online } from '../lib/tee.js';
import { registerDevSigner } from '../runner/core.js';

const id = process.env.ANT_CONTRACT;
const acc = account(id);
const wasm = readFileSync(path.join(ROOT, 'out', 'antrepreneur.wasm'));
console.log(`Deploying ${wasm.length} bytes to ${id} (balance ${fromYocto(await acc.getBalance())} NEAR)`);
const d = await acc.deployContract(new Uint8Array(wasm));
console.log('  deploy tx', txUrl(d.transaction.hash));
let initialized = true;
try { await view('get_config', {}, id); } catch { initialized = false; }
if (!initialized) {
  const r = await acc.callFunctionRaw({
    contractId: id, methodName: 'new', gas: 100n * 10n ** 12n,
    args: { owner: process.env.ANT_OPS, inference_treasury: process.env.ANT_TREASURY, reviewer_model: REVIEWER_MODEL, reviewer_prompt: REVIEW_PROMPT, config: null },
  });
  console.log('  init tx  ', txUrl(r.transaction.hash));
} else console.log('  already initialized (code upgraded, state kept)');

const att = await attest(REVIEWER_MODEL, { fresh: true });
console.log(`judge ${REVIEWER_MODEL}: attestation ${att.verified ? 'VERIFIED' : 'NOT VERIFIED'}`);
if (att.verified) {
  const keys = [...att.signingAddresses.map((k) => [k, REVIEWER_MODEL]), ...(att.gatewayAddress ? [[att.gatewayAddress, 'gateway']] : [])];
  for (const [k, model] of keys) {
    const r = await call(process.env.ANT_OPS, 'register_tee_signer', { public_key: k, model, attestation_hash: att.reportHash });
    console.log(`  registered ${model === 'gateway' ? 'gateway' : 'model'} TEE key ${k.slice(0, 16)}...`, txUrl(r.hash));
  }
}
if (!online()) console.log('  DEV signer for offline mode (NOT a TEE):', await registerDevSigner({ quiet: true }));
const rv = await view('get_reviewer', {}, id);
console.log(`judge prompt hash ${rv.prompt_hash}, registered signers: ${(await view('list_tee_signers', {}, id)).length}`);
