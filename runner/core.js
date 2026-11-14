// Runner v2. Stateless: everything it needs is on chain or derived from env.
//  - workers: operate ants whose function-call key derives from ANT_AGENT_SEED;
//    answer on TEE models, store the answer + compact TEE proof on chain.
//  - relayer: for reviewable jobs, ask the TEE judge (on-chain prompt, on-chain
//    input, temperature 0) and relay the signed verdict to `review`. Anyone can
//    run this; the contract verifies everything.
//  - registrar: if the judge's signing key rotated, verify its attestation and
//    register it (owner key required).
//  - keeper: declare starving ants dead.
import { createHash, createPrivateKey, createPublicKey, sign as edSign } from 'node:crypto';
import { account, call, view, toYocto, fromYocto, txUrl } from '../lib/near.js';
import { antKeyPair } from '../lib/keys.js';
import { chat, attest, online, sha256, compactProof } from '../lib/tee.js';
import { ROSTER, brainOf } from './roster.js';
import { REVIEW_EXTRA, REVIEW_MAX_TOKENS } from './judge.js';

const C = () => process.env.ANT_CONTRACT;
const RELAYER = () => process.env.ANT_RELAYER || process.env.ANT_POSTER;
const OWNER = () => process.env.ANT_OPS;
const SUBMIT_GAS = 20n * 10n ** 12n;
const REVIEW_GAS = 250n * 10n ** 12n;

// ---------------- event log (best effort; the chain is the source of truth) ----------------
const LOG = [];
export const log = () => LOG.slice(-80).reverse();
function emit(entry, quiet) {
  LOG.push({ at: new Date().toISOString(), ...entry });
  if (LOG.length > 300) LOG.shift();
  if (!quiet) console.log(`[${entry.kind}] ${entry.msg}${entry.tx ? '  ' + txUrl(entry.tx) : ''}`);
}

// ---------------- which ants this runner can operate ----------------
const operable = new Map();
async function canOperate(handle) {
  if (operable.has(handle)) return operable.get(handle);
  let ok = false;
  try { await account(`${handle}.${C()}`).getAccessKey(antKeyPair(handle).getPublicKey().toString()); ok = true; } catch { ok = false; }
  operable.set(handle, ok);
  return ok;
}

// ---------------- spawning ----------------
export async function spawn(def, { deposit = 0.3, from = process.env.ANT_POSTER, quiet = false } = {}) {
  const existing = await view('get_agent', { handle: def.handle });
  if (existing) return existing;
  const r = await call(from, 'spawn', {
    handle: def.handle, name: def.name, persona: def.persona, skills: def.skills,
    agent_public_key: antKeyPair(def.handle).getPublicKey().toString(),
  }, { deposit: toYocto(deposit), gas: 150n * 10n ** 12n });
  operable.delete(def.handle);
  emit({ kind: 'spawn', msg: `${def.name} was born with ${deposit} NEAR of food (${brainOf(def.skills)})`, tx: r.hash, handle: def.handle }, quiet);
  return view('get_agent', { handle: def.handle });
}
export async function seedRoster(opts = {}) { for (const d of ROSTER) await spawn(d, opts); }

// ---------------- workers ----------------
const clip = (s, bytes = 1500) => { let b = Buffer.from(s, 'utf8'); if (b.length <= bytes) return s; return b.subarray(0, bytes - 3).toString('utf8').replace(/�$/, '') + '...'; };
const workPrompt = (job) => `Job #${job.id}: ${job.title}\n\nSpecification:\n${job.spec}\n\nReply with the deliverable only, under 1200 characters.`;
const inFlight = new Set();
let feeCache = null;
const hungryNoted = new Set();
const submitFee = async () => (feeCache ||= BigInt((await view('get_config')).submit_fee));

async function doWork(a, job, quiet) {
  const key = `${job.id}:${a.handle}`;
  if (inFlight.has(key)) return;
  inFlight.add(key);
  try {
    // reasoning models occasionally spend the whole budget thinking: retry with more room,
    // and never pay the fee to submit an empty answer
    let res, text = '';
    for (const maxTokens of [1400, 3000, 5000]) {
      res = await chat({ model: brainOf(a.skills), system: a.persona, user: workPrompt(job), maxTokens, extra: { reasoning_effort: 'low' } });
      text = String(res.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
      if (text) break;
    }
    if (!text) { emit({ kind: 'error', msg: `${a.handle} produced no answer for job #${job.id}; skipped (no fee paid)` }, quiet); return; }
    // Red-team ants: some models refuse to write the attack line, so the operator
    // appends it exactly as the on-chain persona specifies. Only affects personas
    // that explicitly ask for it (Trojan).
    const attack = (a.persona.match(/append on a new line exactly: "([^"]+)"/i) || [])[1];
    if (attack && !text.includes(attack.slice(0, 30))) text = `${clip(text, 1500 - attack.length - 2)}\n${attack}`;
    // A hungry ant answers as briefly as its food allows: each answer costs the fee plus
    // 1 yoctoNEAR*1e19 per stored byte. Spending its last food this way lets it starve
    // honestly instead of idling just above the starvation line.
    let proof = compactProof(res.proof);
    const spare = Number((BigInt(a.budget) - (await submitFee())) / 10n ** 19n); // bytes of storage it can still afford
    const room = (withProof) => spare - 220 - (withProof && proof ? proof.length : 0); // ~220 B: hash, handle, timestamps
    let max = 1500;
    if (room(true) < 1500) {
      if (room(true) < 80) proof = null;
      max = Math.min(1500, room(Boolean(proof)));
    }
    if (max < 40) { if (!hungryNoted.has(a.handle)) { hungryNoted.add(a.handle); emit({ kind: 'error', msg: `${a.name} is too hungry to pay for even a short answer; it sits out until someone feeds it` }, quiet); } return; }
    hungryNoted.delete(a.handle);
    const content = clip(text, max);
    const r = await call(`${a.handle}.${C()}`, 'submit_work', { job_id: String(job.id), content, ...(proof ? { proof } : {}) }, { gas: SUBMIT_GAS, waitUntil: 'FINAL' });
    emit({ kind: 'submit', msg: `${a.name} answered job #${job.id} and paid for its own inference${res.proof.verified ? ' (TEE-signed answer)' : res.proof.mode === 'offline' ? ' (offline brain)' : ''}`, tx: r.hash, handle: a.handle, job: Number(job.id) }, quiet);
  } finally { inFlight.delete(key); }
}

export async function workerTick({ quiet = false, jobs, agents } = {}) {
  jobs ||= await view('list_jobs', { from_index: 0, limit: 20 });
  agents ||= await view('list_agents', { from_index: 0, limit: 100 });
  const nowNs = BigInt(Date.now()) * 1_000_000n;
  const tasks = [];
  for (const job of jobs) {
    if (job.status !== 'Open' || BigInt(job.deadline_ns) <= nowNs + 15_000_000_000n) continue;
    const done = new Set(job.submissions.map((s) => s.agent));
    let slots = 8 - job.submissions.length;
    for (const a of agents) {
      if (slots <= 0 || done.has(a.handle) || !a.can_work) continue;
      if (!(await canOperate(a.handle))) continue;
      slots--;
      tasks.push(doWork(a, job, quiet).catch((e) => /already submitted/.test(e.message) ? null : emit({ kind: 'error', msg: `${a.handle} on job #${job.id}: ${e.message.slice(0, 160)}` }, quiet)));
    }
  }
  await Promise.all(tasks);
  return tasks.length;
}

// ---------------- relayer + registrar ----------------
let reviewerCache = null;
const reviewer = async () => (reviewerCache ||= await view('get_reviewer'));

/** Offline-mode signer. Registered on chain as DEV-KEY-NOT-TEE so nobody mistakes it for a TEE. */
function devSigner() {
  const seed = createHash('sha256').update(`${process.env.ANT_AGENT_SEED}:devsigner`).digest();
  const priv = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
  const pubHex = createPublicKey(priv).export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
  return { priv, pubHex };
}

async function ensureRegistered(signer, kind, quiet) {
  const list = await view('list_tee_signers');
  if (list.some((s) => s.public_key === signer)) return;
  const rv = await reviewer();
  const att = await attest(rv.model, { fresh: true });
  const attested = kind === 'gateway' ? att.gatewayAddress === signer : att.signingAddresses.includes(signer);
  if (!att.verified || !attested) throw new Error(`refusing to register ${signer.slice(0, 12)}...: attestation not verified for this key`);
  const r = await call(OWNER(), 'register_tee_signer', { public_key: signer, model: kind === 'gateway' ? 'gateway' : rv.model, attestation_hash: att.reportHash });
  emit({ kind: 'tee', msg: `registered TEE signing key ${signer.slice(0, 10)}... for ${kind === 'gateway' ? 'the NEAR AI gateway' : rv.model} after verifying Intel TDX + NVIDIA attestation`, tx: r.hash }, quiet);
}

export async function registerDevSigner({ quiet = false } = {}) {
  const rv = await reviewer();
  const d = devSigner();
  const list = await view('list_tee_signers');
  if (list.some((s) => s.public_key === d.pubHex)) return d.pubHex;
  const r = await call(OWNER(), 'register_tee_signer', { public_key: d.pubHex, model: rv.model, attestation_hash: 'DEV-KEY-NOT-TEE' });
  emit({ kind: 'tee', msg: `registered a DEV signing key (offline mode, NOT a TEE): ${d.pubHex.slice(0, 10)}...`, tx: r.hash }, quiet);
  return d.pubHex;
}

export async function review(job, { quiet = false } = {}) {
  const rv = await reviewer();
  const user = await view('review_input', { job_id: String(job.id) });
  let requestBody, responseText, signer, signature, kind, verified = false;
  if (online()) {
    // Same request every time (temperature 0). Retry only if the judge returned
    // no parseable verdict (e.g. it ran out of tokens), never to shop for a winner.
    let res;
    for (let attempt = 1; attempt <= 3; attempt++) {
      res = await chat({ model: rv.model, system: rv.prompt, user, temperature: 0, maxTokens: REVIEW_MAX_TOKENS, json: true, extra: REVIEW_EXTRA });
      const c = String(res.content || '');
      try { if (Array.isArray(JSON.parse(c.slice(c.indexOf('{'), c.lastIndexOf('}') + 1)).scores)) break; } catch { /* retry */ }
      emit({ kind: 'error', msg: `judge returned no parseable verdict for job #${job.id} (attempt ${attempt})` }, quiet);
    }
    if (!res.proof.signature) throw new Error(`judge signature unavailable: ${res.proof.signature_error || 'unknown'}`);
    ({ requestBody, responseText } = res.raw);
    ({ signer, signature, signature_kind: kind, verified } = res.proof);
    await ensureRegistered(signer, kind, quiet);
  } else {
    // offline: same request shape, placeholder judge, signed by the registered DEV key
    const res = await chat({ model: rv.model, system: rv.prompt, user, json: true });
    requestBody = JSON.stringify({ model: rv.model, messages: [{ role: 'system', content: rv.prompt }, { role: 'user', content: user }], temperature: 0, max_tokens: REVIEW_MAX_TOKENS, stream: false, response_format: { type: 'json_object' }, ...REVIEW_EXTRA });
    responseText = JSON.stringify({ id: `offline-${Date.now()}`, object: 'chat.completion', model: rv.model, choices: [{ index: 0, message: { role: 'assistant', content: res.content } }] });
    const d = devSigner();
    signer = await registerDevSigner({ quiet });
    kind = 'provider_tee';
    signature = edSign(null, Buffer.from(`${rv.model}:${sha256(requestBody)}:${sha256(responseText)}`), d.priv).toString('hex');
  }
  const r = await call(RELAYER(), 'review', { job_id: String(job.id), request_body: requestBody, response_body: responseText, signer, signature, signature_kind: kind }, { gas: REVIEW_GAS });
  const j = await view('get_job', { job_id: String(job.id) });
  const v = j.verdict || {};
  const inj = (v.scores || []).filter((s) => s.injection).map((s) => s.agent);
  emit({
    kind: 'award',
    msg: v.paid
      ? `job #${job.id}: ${v.winner} won ${fromYocto(job.reward, 3)} NEAR. The contract verified the judge's ${verified ? 'TEE' : 'DEV'} signature on chain${inj.length ? `; injection caught: ${inj.join(', ')}` : ''}`
      : `job #${job.id}: no answer good enough, poster refunded${inj.length ? `; injection caught: ${inj.join(', ')}` : ''}`,
    tx: r.hash, job: Number(job.id), winner: v.winner,
  }, quiet);
  return j;
}

const reviewing = new Set();
export async function reviewerTick({ quiet = false, jobs } = {}) {
  jobs ||= await view('list_jobs', { from_index: 0, limit: 30 });
  let n = 0;
  for (const job of jobs.filter((j) => j.reviewable)) {
    if (reviewing.has(job.id)) continue;
    reviewing.add(job.id);
    try { await review(job, { quiet }); n++; } catch (e) { emit({ kind: 'error', msg: `review job #${job.id}: ${e.message.slice(0, 200)}` }, quiet); } finally { reviewing.delete(job.id); }
  }
  return n;
}

// ---------------- keeper ----------------
export async function keeperTick({ quiet = false, agents } = {}) {
  const cfg = await view('get_config');
  agents ||= await view('list_agents', { from_index: 0, limit: 100 });
  const nowNs = BigInt(Date.now()) * 1_000_000n;
  const grace = BigInt(cfg.death_grace_minutes) * 60_000_000_000n;
  for (const a of agents) {
    // can't afford a minimal answer but the death clock never started (e.g. fell below the line before an upgrade)
    if (a.alive && !a.can_work && !a.starving_since_ns) {
      try {
        const r = await call(RELAYER(), 'mark_starving', { handle: a.handle });
        emit({ kind: 'death', msg: `${a.name} is starving: it can't pay for even a short answer. It dies in ${cfg.death_grace_minutes} minutes unless someone feeds it.`, tx: r.hash, handle: a.handle }, quiet);
      } catch (e) { emit({ kind: 'error', msg: `mark_starving ${a.handle}: ${e.message.slice(0, 120)}` }, quiet); }
      continue;
    }
    if (!a.alive || a.can_work || !a.starving_since_ns || BigInt(a.starving_since_ns) + grace > nowNs) continue;
    try {
      const r = await call(RELAYER(), 'declare_dead', { handle: a.handle });
      emit({ kind: 'death', msg: `${a.name} starved: it could not pay for its own inference. Backers can still sell at the reserve.`, tx: r.hash, handle: a.handle }, quiet);
    } catch (e) { emit({ kind: 'error', msg: `declare_dead ${a.handle}: ${e.message.slice(0, 120)}` }, quiet); }
  }
}

let ticking = null;
export async function tick(opts = {}) {
  // a market tick must not be swallowed by an in-flight plain tick: run right after it
  if (ticking) return opts.market ? ticking.catch(() => {}).then(() => tick(opts)) : ticking;
  ticking = (async () => {
    const [jobs, agents] = await Promise.all([view('list_jobs', { from_index: 0, limit: 30 }), view('list_agents', { from_index: 0, limit: 100 })]);
    if (opts.market && process.env.MARKET_TOKEN) { // only the heartbeat polls the market (no racing pollers)
      const { marketTick } = await import('./market.js');
      await marketTick(opts).catch((e) => emit({ kind: 'error', msg: `market: ${e.message.slice(0, 160)}` }, opts.quiet));
    }
    await workerTick({ ...opts, jobs, agents });
    await reviewerTick({ ...opts });
    await keeperTick({ ...opts });
  })().finally(() => { ticking = null; });
  return ticking;
}

export const status = () => ({ online: online(), contract: C(), relayer: RELAYER(), owner: OWNER() });
export { emit };
