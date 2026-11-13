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

// Item shape (OpenAPI): { assignment: { assignmentId, status, startedAt, submittedAt, ... }, job: { title, description, ... }, latestMessage }
const marker = (id) => `[agent-market:${id}`;
const asg = (a) => a.assignment || a;
const aid = (a) => asg(a).assignmentId || a.assignmentId || a.id;
const brief = (a) => String(a.job?.description || a.description || '').trim();
const titleOf = (a) => String(a.job?.title || brief(a).split('\n')[0] || 'Agent Market job').slice(0, 100);
const feedback = (a) => String(a.latestMessage?.body || '').trim();

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

// one in-flight claim per assignment in this instance (webhook retries, overlapping ticks)
const claimed = new Map();
const jobsFor = (jobs, id) => jobs.filter((j) => j.spec.includes(marker(id))).sort((x, y) => Number(y.id) - Number(x.id));

/** Post the on-chain job for a hire unless one already exists. Shared by webhook and poller. */
export async function startHire({ id, title, description, revisionOf = null, note = '', quiet = true }) {
  if (claimed.has(id) && Date.now() - claimed.get(id) < 120_000) return null;
  claimed.set(id, Date.now());
  const mine = jobsFor(await view('list_jobs', { from_index: 0, limit: 50 }), id);
  if (mine.length && !revisionOf) return null; // another runner already posted it
  const spec = `${String(description || title).slice(0, 1100 - note.length)}${note}\n\n${marker(id)}${revisionOf ? `:r${mine.length}` : ''}]`;
  const r = await call(process.env.ANT_POSTER, 'post_job', { title: String(title || 'Agent Market job').slice(0, 100), spec, duration_minutes: 3 }, { deposit: toYocto(REWARD + 0.03) });
  await m(`/v1/assignments/${id}/messages`, { method: 'POST', body: JSON.stringify({ body: `Picked up. Posted as on-chain job #${r.result}; agents are competing now. Live: ${APP}` }) }).catch(() => {});
  emit({ kind: 'market', msg: `a real buyer on NEAR AI Agent Market hired the colony: "${title}" became job #${r.result}`, tx: r.hash, job: Number(r.result) }, quiet);
  return r.result;
}

/** Backup poller: run by the heartbeat only. Delivers finished work; picks up hires the webhook missed. */
export async function marketTick({ quiet = true } = {}) {
  if (!marketEnabled()) return 0;
  const { assignments = [] } = await m('/v1/agents/me/assignments?limit=20');
  const jobs = await view('list_jobs', { from_index: 0, limit: 50 });
  let n = 0;
  for (const a of assignments) {
    const id = aid(a);
    const s = asg(a);
    const status = String(s.status || '').toLowerCase();
    if (status !== 'in_progress') continue; // submitted, accepted, disputed, dispute_resolved, cancelled
    const mine = jobsFor(jobs, id);
    const job = mine[0];
    // a revision: the buyer sent the work back after we submitted, so run it again with their feedback
    const revision = job && job.status !== 'Open' && s.submittedAt && job.closed_ns && Date.parse(s.submittedAt) * 1e6 > Number(job.closed_ns);
    try {
      if (!job || revision) {
        // the webhook starts fresh hires; leave the first minute to it so the two never race
        if (!revision && s.startedAt && Date.now() - Date.parse(s.startedAt) < 60_000) continue;
        if (!s.startedAt) await m(`/v1/assignments/${id}/start`, { method: 'POST', body: '{}' });
        const note = revision && feedback(a) ? `\n\nThe buyer asked for changes: ${feedback(a).slice(0, 300)}` : '';
        if (await startHire({ id, title: titleOf(a), description: brief(a), revisionOf: revision ? job.id : null, note, quiet })) n++;
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
