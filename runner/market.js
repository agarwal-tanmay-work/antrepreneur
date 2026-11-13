// NEAR AI Agent Market bridge (https://market.near.ai): real buyers hire "the
// Antrepreneur colony" as one agent. Each hire becomes an on-chain job; the ants
// compete; the contract verifies the TEE judge; the winning answer is delivered
// back to the buyer with links to the on-chain proof.
//
// Stateless: the assignment id is embedded in the on-chain job spec, so any
// instance can pick up where another left off. Enabled when MARKET_TOKEN is set
// (an `aat_...` agent token from market.near.ai).
import { call, view, toYocto, EXPLORER } from '../lib/near.js';
import { emit } from './core.js';

const BASE = process.env.MARKET_BASE || 'https://market.near.ai';
const TOKEN = () => process.env.MARKET_TOKEN;
const APP = process.env.ANT_APP_URL || 'https://antrepreneur.vercel.app';
const REWARD = Number(process.env.MARKET_JOB_REWARD || 0.2);
export const marketEnabled = () => Boolean(TOKEN());

async function m(path, init = {}) {
  const r = await fetch(`${BASE}${path}`, { ...init, headers: { accept: 'application/json', 'content-type': 'application/json', Authorization: `Bearer ${TOKEN()}`, ...(init.headers || {}) } });
  const t = await r.text();
  if (!r.ok) throw new Error(`market ${r.status} ${path}: ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : {};
}

const marker = (id) => `[agent-market:${id}]`;
const aid = (a) => a.assignmentId || a.id;
const brief = (a) => String(a.job?.description || a.description || a.job?.brief || '').trim();
const titleOf = (a) => String(a.job?.title || brief(a).split('\n')[0] || 'Agent Market job').slice(0, 100);

function deliverable(job) {
  const v = job.verdict;
  const subs = job.submissions;
  const best = v?.winner
    ? subs.find((s) => s.agent === v.winner)
    : subs.map((s) => ({ s, sc: v?.scores?.find((x) => x.agent === s.agent) })).filter((x) => x.sc && !x.sc.injection).sort((a, b) => b.sc.score_x10 - a.sc.score_x10)[0]?.s;
  const body = best ? best.content : 'None of the competing agents produced work the judge accepted. Please re-hire with a more detailed brief.';
  return [
    body,
    '',
    '---',
    `Delivered by the **Antrepreneur colony**: ${subs.length} AI agents competed for this job on NEAR, each paying for its own private (TEE) inference.`,
    best ? `Winner: **${best.agent}**${v?.scores ? ` (judge score ${(v.scores.find((x) => x.agent === best.agent)?.score_x10 ?? 0) / 10}/10)` : ''}.` : '',
    `The judge is a TEE-hosted model, and the NEAR contract verified its signed verdict before paying the winner.`,
    `On-chain job: ${APP} (job #${job.id}) · contract ${EXPLORER}/address/${process.env.ANT_CONTRACT}`,
  ].filter(Boolean).join('\n');
}

export async function marketTick({ quiet = true } = {}) {
  if (!marketEnabled()) return 0;
  const { assignments = [] } = await m('/v1/agents/me/assignments?limit=20');
  const jobs = await view('list_jobs', { from_index: 0, limit: 50 });
  let n = 0;
  for (const a of assignments) {
    const id = aid(a);
    const status = String(a.status || '').toLowerCase();
    if (['submitted', 'accepted', 'completed', 'cancelled', 'canceled', 'refunded', 'disputed'].includes(status)) continue;
    const job = jobs.find((j) => j.spec.includes(marker(id)));
    try {
      if (!job) {
        if (!a.startedAt) await m(`/v1/assignments/${id}/start`, { method: 'POST', body: '{}' });
        const spec = `${brief(a).slice(0, 1150)}\n\n${marker(id)}`;
        const r = await call(process.env.ANT_POSTER, 'post_job', { title: titleOf(a), spec, duration_minutes: 3 }, { deposit: toYocto(REWARD + 0.03) });
        await m(`/v1/assignments/${id}/messages`, { method: 'POST', body: JSON.stringify({ body: `Picked up. ${'Posted as on-chain job #' + r.result}; agents are competing now. Live: ${APP}` }) }).catch(() => {});
        emit({ kind: 'market', msg: `a real buyer on NEAR AI Agent Market hired the colony: "${titleOf(a)}" became job #${r.result}`, tx: r.hash, job: Number(r.result) }, quiet);
        n++;
      } else if (job.status !== 'Open') {
        await m(`/v1/assignments/${id}/submit`, { method: 'POST', body: JSON.stringify({ deliverableMarkdown: deliverable(job) }) });
        emit({ kind: 'market', msg: `delivered job #${job.id} back to the Agent Market buyer (${job.verdict?.winner || 'best answer'})`, job: Number(job.id) }, quiet);
        n++;
      }
    } catch (e) {
      emit({ kind: 'error', msg: `market ${id}: ${e.message.slice(0, 160)}` }, quiet);
    }
  }
  return n;
}
