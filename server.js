// Antrepreneur server: JSON API + runner trigger. Stateless: the contract is the
// database. Runs locally (`npm start`, with a background runner loop) and on
// Vercel (zero-config Express; the runner is driven by /api/tick + waitUntil).
//
// Demo mode: visitors act through a server-held TESTNET demo account (backer,
// poster, relayer), so nobody needs a wallet. Writes are capped and rate limited.
import express from 'express';
import { waitUntil } from '@vercel/functions';
import { view, call, toYocto, fromYocto, txUrl, EXPLORER, NETWORK } from './lib/near.js';
import { attest, online } from './lib/tee.js';
import { quoteFunding, ORIGINS } from './lib/intents.js';
import { tick, spawn, log as runnerLog } from './runner/core.js';
import { ROSTER, REVIEWER_MODEL, BRAINS, brainOf } from './runner/roster.js';
import { runSim, summarize } from './sim/engine.js';

const app = express();
app.use(express.json({ limit: '32kb' }));
const IS_VERCEL = Boolean(process.env.VERCEL);
const C = process.env.ANT_CONTRACT;
const DEMO = process.env.ANT_POSTER;
const bg = (p) => { const q = Promise.resolve(p).catch((e) => console.error('bg:', e.message)); if (IS_VERCEL) waitUntil(q); return q; };

const hits = new Map();
function limited(req, max = 15, windowMs = 60_000) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0];
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < windowMs);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > max;
}
const wrap = (fn) => async (req, res) => {
  try { res.json(await fn(req, res)); } catch (e) { res.status(400).json({ error: String(e.message || e).slice(0, 300) }); }
};
const parseProof = (p) => { try { return p ? JSON.parse(p) : null; } catch { return null; } };

/** Feed derived from chain state (plus tx links from this instance's runner log). */
function chainFeed(agents, jobs) {
  const ev = [];
  const ms = (ns) => Number(BigInt(ns) / 1_000_000n);
  for (const a of agents) {
    ev.push({ t: ms(a.created_ns), kind: 'spawn', msg: `${a.name} was born (${brainOf(a.skills).split('/').pop()})`, handle: a.handle });
    if (!a.alive && a.history.length) ev.push({ t: Number(a.history[a.history.length - 1][0]), kind: 'death', msg: `${a.name} starved: it could not pay for its own inference`, handle: a.handle });
  }
  for (const j of jobs) {
    ev.push({ t: ms(j.created_ns), kind: 'job', msg: `job #${j.id} posted: "${j.title}" (${fromYocto(j.reward, 3)} NEAR in escrow)`, job: Number(j.id) });
    for (const s of j.submissions) ev.push({ t: ms(s.at_ns), kind: 'submit', msg: `${s.agent} answered job #${j.id} and paid for its own inference`, job: Number(j.id), handle: s.agent });
    if (j.verdict) {
      const v = j.verdict;
      const inj = v.scores.filter((s) => s.injection).map((s) => s.agent);
      ev.push({ t: ms(v.at_ns), kind: v.paid ? 'award' : 'reject', job: Number(j.id), msg: v.paid ? `job #${j.id}: ${v.winner} won ${fromYocto(j.reward, 3)} NEAR, verdict signature verified on chain${inj.length ? `; injection caught: ${inj.join(', ')}` : ''}` : `job #${j.id}: no answer good enough, poster refunded${inj.length ? `; injection caught: ${inj.join(', ')}` : ''}` });
    }
  }
  const rl = runnerLog();
  for (const e of ev) {
    const m = rl.find((r) => r.tx && (r.kind === e.kind || (e.kind === 'reject' && r.kind === 'award')) && (r.job ?? null) === (e.job ?? null) && (r.handle ?? null) === (e.handle ?? null));
    if (m) e.tx = m.tx;
  }
  return ev.sort((a, b) => b.t - a.t).slice(0, 60);
}

// ---------------- reads ----------------
// every viewer polls; share one read of the chain per few seconds (and per in-flight request)
let stateCache = { at: 0, value: null, pending: null };
app.get('/api/state', wrap(async () => {
  if (stateCache.value && Date.now() - stateCache.at < 3000) return stateCache.value;
  if (stateCache.pending) return stateCache.pending;
  stateCache.pending = readState().then((v) => { stateCache = { at: Date.now(), value: v, pending: null }; return v; })
    .catch((e) => { stateCache.pending = null; if (stateCache.value) return stateCache.value; throw e; });
  return stateCache.pending;
}));

async function readState() {
  const [stats, config, roles, reviewer, signers, agents, jobs, holdings] = await Promise.all([
    view('get_stats'), view('get_config'), view('get_roles'), view('get_reviewer'), view('list_tee_signers'),
    view('list_agents', { from_index: 0, limit: 100 }), view('list_jobs', { from_index: 0, limit: 25 }),
    DEMO ? view('holdings_of', { account_id: DEMO }) : [],
  ]);
  return {
    network: NETWORK, contract: C, explorer: EXPLORER, online: online(), demoAccount: DEMO,
    roles: { owner: roles[0], treasury: roles[1] }, reviewer, signers, stats, config, holdings,
    agents: agents.map((a) => ({ ...a, brain: brainOf(a.skills) })),
    jobs: jobs.map((j) => ({ ...j, submissions: j.submissions.map((s) => ({ ...s, proof: parseProof(s.proof) })) })),
    feed: chainFeed(agents, jobs),
    serverTime: Date.now(),
  };
}

app.get('/api/job/:id', wrap(async (req) => {
  const j = await view('get_job', { job_id: String(req.params.id) });
  if (!j) throw new Error('no such job');
  return { ...j, submissions: j.submissions.map((s) => ({ ...s, proof: parseProof(s.proof) })) };
}));

app.get('/api/attest', wrap(async (req) => {
  const models = req.query.model ? [String(req.query.model)] : [...new Set([REVIEWER_MODEL, ...Object.values(BRAINS)])];
  return Promise.all(models.map((m) => attest(m).catch((e) => ({ model: m, verified: false, checks: [{ name: 'attestation fetch', ok: false, detail: e.message }] }))));
}));

app.get('/api/quote/buy', wrap(async (req) => view('quote_buy', { handle: String(req.query.handle), shares: String(req.query.shares || 1) })));
app.get('/api/intents/origins', (_req, res) => res.json(Object.entries(ORIGINS).map(([id, o]) => ({ id, label: o.label }))));
app.get('/api/intents/quote', wrap(async (req) => quoteFunding({ origin: String(req.query.origin || 'usdc-base'), amount: String(req.query.amount || '5') })));

let simCache = null;
app.get("/api/sim", wrap(async () => {
  if (!simCache) {
    const rhos = Array.from({ length: 20 }, (_, i) => runSim({ seed: i + 1 }).rho).sort((a, b) => a - b);
    simCache = { ...summarize(runSim({ seed: 42 })), sweep: { worlds: 20, mean: rhos.reduce((a, b) => a + b, 0) / 20, median: rhos[10], min: rhos[0], max: rhos[19] } };
  }
  return simCache;
}));

// ---------------- runner trigger ----------------
let lastTick = 0;
app.post('/api/tick', wrap(async () => {
  if (Date.now() - lastTick < 8000) return { skipped: true };
  lastTick = Date.now();
  bg(tick({ quiet: true }));
  return { started: true };
}));

// ---------------- demo writes (testnet, server-held demo key) ----------------
const guard = (req) => {
  if (NETWORK !== 'testnet') throw new Error('demo writes are testnet-only');
  if (!DEMO) throw new Error('demo account not configured');
  if (limited(req)) throw new Error('slow down: rate limit');
};

app.post('/api/demo/buy', wrap(async (req) => {
  guard(req);
  const handle = String(req.body.handle);
  const shares = Math.max(1, Math.min(20, Number(req.body.shares) || 1));
  const q = await view('quote_buy', { handle, shares: String(shares) });
  const r = await call(DEMO, 'buy', { handle, shares: String(shares), max_cost: q.total }, { deposit: BigInt(q.total) + toYocto(0.01) });
  return { tx: r.hash, url: txUrl(r.hash), paid: q.total };
}));

app.post('/api/demo/sell', wrap(async (req) => {
  guard(req);
  const handle = String(req.body.handle);
  const shares = Math.max(1, Math.min(1000, Number(req.body.shares) || 1));
  const r = await call(DEMO, 'sell', { handle, shares: String(shares) });
  return { tx: r.hash, url: txUrl(r.hash), refund: r.result };
}));

app.post('/api/demo/fund', wrap(async (req) => {
  guard(req);
  const amount = Math.max(0.02, Math.min(0.2, Number(req.body.amount) || 0.05));
  const r = await call(DEMO, 'fund_budget', { handle: String(req.body.handle) }, { deposit: toYocto(amount) });
  return { tx: r.hash, url: txUrl(r.hash) };
}));

app.post('/api/demo/job', wrap(async (req) => {
  guard(req);
  const title = String(req.body.title || '').trim().slice(0, 120);
  const spec = String(req.body.spec || '').trim().slice(0, 1200);
  const reward = Math.max(0.06, Math.min(0.5, Number(req.body.reward) || 0.15));
  const minutes = Math.max(2, Math.min(10, Number(req.body.minutes) || 2));
  if (!title) throw new Error('title required');
  const r = await call(DEMO, 'post_job', { title, spec, duration_minutes: minutes }, { deposit: toYocto(reward + 0.03) });
  lastTick = Date.now();
  bg(tick({ quiet: true }));
  return { tx: r.hash, url: txUrl(r.hash), job_id: r.result };
}));

app.post('/api/demo/spawn', wrap(async (req) => {
  guard(req);
  const handle = String(req.body.handle || '').toLowerCase();
  const brain = Object.keys(BRAINS).includes(req.body.brain) ? req.body.brain : 'qwen';
  const persona = String(req.body.persona || '').trim().slice(0, 800);
  if (persona.length < 20) throw new Error('persona: at least 20 characters');
  const name = String(req.body.name || handle).slice(0, 48);
  const a = await spawn({ handle, name, persona, skills: [`brain:${brain}`, 'community'] }, { deposit: 0.3, from: DEMO, quiet: true });
  return { agent: a };
}));

app.get('/api/health', (_req, res) => res.json({ ok: true, contract: C, online: online(), roster: ROSTER.length }));

// ---------------- web app ----------------
if (IS_VERCEL) {
  // static files live on Vercel's CDN (public/**); serve the SPA shell for page routes
  let shell = null;
  app.get(/^(?!\/api)(?!.*\.\w+$).*/, async (req, res) => {
    try {
      shell ||= await (await fetch(`https://${req.headers.host}/index.html`)).text();
      res.set('content-type', 'text/html; charset=utf-8').set('cache-control', 'public, max-age=60').send(shell);
    } catch (e) { res.status(500).send('could not load app shell'); }
  });
}

// ---------------- local mode ----------------
if (!IS_VERCEL) {
  const { default: path } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const pub = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
  app.use(express.static(pub));
  app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(pub, 'index.html')));
  const PORT = Number(process.env.PORT || 3000);
  app.listen(PORT, () => console.log(`Antrepreneur on http://localhost:${PORT}  (contract ${C}, ${online() ? 'NEAR AI Cloud TEE' : 'OFFLINE brain + DEV signer'})`));
  if (process.env.RUNNER !== '0') {
    const every = Number(process.env.RUNNER_INTERVAL_SEC || 8) * 1000;
    setInterval(() => tick({ quiet: true }).catch((e) => console.error('runner:', e.message)), every);
  }
}

export default app;
