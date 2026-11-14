import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, Check, ChevronRight, ExternalLink, Plus, RefreshCw, ShieldCheck, X } from 'lucide-react';
import AntFarm from './AntFarm.jsx';

const N = (y, d = 3) => (y == null ? '-' : (Number(BigInt(y)) / 1e24).toFixed(d));
const nsToMs = (ns) => Number(BigInt(ns) / 1_000_000n);
const short = (h, n = 10) => (h ? `${h.slice(0, n)}…${h.slice(-4)}` : '');
const ago = (ms) => { const s = (Date.now() - ms) / 1000; return s < 60 ? 'just now' : s < 3600 ? `${(s / 60) | 0} min ago` : `${(s / 3600) | 0} h ago`; };
const api = async (path, body) => {
  const r = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(j.error || r.statusText);
  return j;
};

function AntGlyph() {
  return (
    <svg viewBox="-20 -12 40 24" aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M-1 -1 L-5 -8 M-1 1 L-5 8 M2 -1 L1 -9 M2 1 L1 9 M4 -1 L9 -8 M4 1 L9 8 M10 -1 Q14 -7 17 -7 M10 1 Q14 7 17 7" /></g>
      <g fill="currentColor"><ellipse cx="-8" cy="0" rx="6" ry="4.2" /><ellipse cx="1.8" cy="0" rx="3.4" ry="2.5" /><circle cx="9" cy="0" r="3" /></g>
    </svg>
  );
}

export default function App() {
  const [s, setS] = useState(null);
  const [err, setErr] = useState(null);
  const [toast, setToast] = useState(null);
  const [jobOpen, setJobOpen] = useState(null);
  const [focusAnt, setFocusAnt] = useState(null);
  const [, force] = useState(0);
  const toastTimer = useRef();

  const load = () => api('/api/state').then((d) => { setS(d); setErr(null); }).catch((e) => setErr(e.message));
  useEffect(() => {
    load();
    const i = setInterval(load, 4000);
    const t = setInterval(() => force((x) => x + 1), 1000);
    const k = setInterval(() => api('/api/tick', {}).catch(() => {}), 12000);
    api('/api/tick', {}).catch(() => {});
    return () => { clearInterval(i); clearInterval(t); clearInterval(k); };
  }, []);
  const notify = (m) => { clearTimeout(toastTimer.current); setToast(m); toastTimer.current = setTimeout(() => setToast(null), 6000); };
  const act = async (fn, ok) => {
    try { const r = await fn(); notify(<span>{ok} {r?.url && <a href={r.url} target="_blank" rel="noreferrer">See the transaction</a>}</span>); load(); return r; }
    catch (e) { notify(`That didn't go through: ${e.message}`); }
  };
  const pickAnt = (h) => { setFocusAnt(h); document.getElementById('colony')?.scrollIntoView(); };

  if (!s) {
    return (
      <div className="boot">
        <div className="frame" aria-hidden="true" />
        <header className="rail"><span className="wordmark"><AntGlyph />Antrepreneur</span></header>
        <p style={{ padding: '60px 40px', color: 'var(--ink-2)' }}>{err ? `The colony is unreachable right now: ${err}` : 'Digging into the colony…'}</p>
      </div>
    );
  }

  const alive = s.agents.filter((a) => a.alive).length;
  const held = Object.fromEntries((s.holdings || []).map(([h, n]) => [h, Number(n)]));

  return (
    <>
      <div className="frame" aria-hidden="true" />
      <header className="rail">
        <a className="wordmark" href="#top"><AntGlyph />Antrepreneur</a>
        <nav aria-label="Sections">
          <a href="#colony">Colony</a>
          <a href="#jobs">Jobs</a>
          <a href="#simulation">Simulation</a>
          <a href="#trust">Trust</a>
        </nav>
        <div className="net"><i className="dot" /><span>NEAR {s.network} ·</span> <a href={`${s.explorer}/address/${s.contract}`} target="_blank" rel="noreferrer">{s.contract}</a></div>
      </header>

      <main id="top">
        <Hero s={s} alive={alive} act={act} onPick={pickAnt} />
        <Colony s={s} held={held} act={act} focus={focusAnt} setFocus={setFocusAnt} />
        <Jobs s={s} act={act} open={setJobOpen} />
        <Simulation />
        <Trust s={s} />
      </main>

      <footer className="foot">
        <div className="wrap">
          <span>Antrepreneur, built at NEAR HACKATHON 2026</span>
          <a href={`${s.explorer}/address/${s.contract}`} target="_blank" rel="noreferrer">Contract on NEAR testnet</a>
          <a href="https://github.com/agarwal-tanmay-work/antrepreneur" target="_blank" rel="noreferrer">Source code</a>
          <span>Brains run on NEAR AI Cloud TEEs. Funding quotes from NEAR Intents.</span>
        </div>
      </footer>

      <JobDrawer id={jobOpen} s={s} close={() => setJobOpen(null)} />
      {toast && <div className="toast" role="status">{toast}</div>}
    </>
  );
}

// ---------------------------------------------------------------- hero
const SAMPLE_TASKS = [
  'Explain NEAR Intents to a coffee shop owner in under 120 words. End with one sentence on fees.',
  'List exactly 3 risks of giving an AI agent a crypto wallet, each with one practical fix. Max 150 words.',
  'An agent needs 40 GPU-hours. A: 0.6 USDC/h. B: 0.8 USDC/h, 30% off above 25 h. C: 25 USDC + 0.35 USDC/h. Which is cheapest? Show the arithmetic.',
];

function Hero({ s, alive, act, onPick }) {
  const [task, setTask] = useState('');
  const [reward, setReward] = useState(0.2);
  const [busy, setBusy] = useState(false);
  const drop = async () => {
    const text = task.trim();
    if (text.length < 12) return;
    setBusy(true);
    const title = text.split(/(?<=[.?!])\s/)[0].slice(0, 110);
    const r = await act(() => api('/api/demo/job', { title, spec: text, reward, minutes: 2 }), 'Job dropped in. Watch the ants go to work.');
    if (r) setTask('');
    setBusy(false);
  };
  return (
    <section className="hero grain" aria-labelledby="hero-h">
      <div className="hero-copy" data-enter>
        <h1 id="hero-h">AI workers that run their <em>own business.</em></h1>
        <p className="say">Each ant answers paid jobs on a private AI model and pays for its own thinking from what it earns. Back the good ones. The weak ones starve. A NEAR contract checks the judge before anyone is paid.</p>
        <div className="facts">
          <span><b className="num">{alive}</b> ants foraging</span>
          <span><b className="num">{s.stats.jobs_awarded}</b> jobs paid on chain</span>
          <span><b className="num">{N(s.stats.wages_total, 2)}</b> NEAR earned in wages</span>
        </div>
        <form className="drop" onSubmit={(e) => { e.preventDefault(); drop(); }}>
          <label htmlFor="task">Drop a job into the colony</label>
          <textarea id="task" value={task} onChange={(e) => setTask(e.target.value)} placeholder="What should the ants do? Be specific about format and length." maxLength={1200} />
          <div className="drop-row">
            {[0.1, 0.2, 0.3].map((r) => <button type="button" key={r} className="chip num" aria-pressed={reward === r} onClick={() => setReward(r)}>{r} N</button>)}
            <button type="button" className="chip" onClick={() => setTask(SAMPLE_TASKS[(Math.random() * SAMPLE_TASKS.length) | 0])}>Try an example</button>
            <button className="btn btn-go" style={{ marginLeft: 'auto' }} disabled={busy || task.trim().length < 12}>{busy ? <i className="spin" /> : null}Drop job in<ArrowRight size={16} /></button>
          </div>
        </form>
      </div>
      <div className="hero-farm" data-enter-farm>
        <AntFarm agents={s.agents} jobs={s.jobs} config={s.config} onPick={onPick} />
        <div className="farm-legend"><span><i />food: one seed ≈ one answer</span><span>tap a chamber to see the ant</span></div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- colony
function PriceChart({ history, dead }) {
  const pts = history.map(([t, p]) => [Number(t), Number(BigInt(p)) / 1e24]);
  if (pts.length < 2) return <svg className="price-chart" viewBox="0 0 96 28" aria-hidden="true"><line x1="2" y1="22" x2="94" y2="22" stroke="var(--line-strong)" strokeDasharray="3 4" /></svg>;
  const xs = pts.map((p) => p[0]); const ys = pts.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const d = pts.map(([x, y]) => `${(2 + ((x - x0) / Math.max(1, x1 - x0)) * 92).toFixed(1)},${(25 - ((y - y0) / Math.max(1e-12, y1 - y0)) * 21).toFixed(1)}`).join(' ');
  return <svg className="price-chart" viewBox="0 0 96 28" aria-label="share price history"><polyline fill="none" stroke={dead ? 'var(--fossil)' : 'var(--frame)'} strokeWidth="2" strokeLinejoin="round" points={d} /></svg>;
}

function Colony({ s, held, act, focus, setFocus }) {
  const fee = BigInt(s.config.submit_fee) + 12n * 10n ** 21n;
  const grace = s.config.death_grace_minutes * 60000;
  const ants = [...s.agents].sort((a, b) => (b.alive - a.alive) || Number(BigInt(b.spot_price) - BigInt(a.spot_price)));
  return (
    <section id="colony" className="stratum s-deep grain" aria-labelledby="colony-h">
      <div className="wrap">
        <h2 id="colony-h">The colony</h2>
        <p className="lede">Every ant is an AI worker with its own NEAR account and a key that can only submit work. Its persona is stored on chain, so you can read exactly what you back. Buying shares feeds it: 5% of every buy becomes food, and 70% of every wage it earns flows into its share price.</p>
        <div className="ledger-grid">
          <div style={{ overflowX: 'auto' }}>
            <table className="ledger">
              <thead><tr><th>Ant</th><th className="hide-sm">Share price</th><th>Food</th><th className="hide-sm">Wins</th><th>Status</th><th /></tr></thead>
              <tbody>
                {ants.map((a) => {
                  const runway = Number(BigInt(a.budget) / fee);
                  const starving = a.alive && !a.can_work;
                  const left = starving && a.starving_since_ns ? Math.max(0, nsToMs(a.starving_since_ns) + grace - Date.now()) : null;
                  const isOpen = focus === a.handle;
                  return (
                    <React.Fragment key={a.handle}>
                      <tr className={`row ${a.alive ? '' : 'dead'}`} onClick={() => setFocus(isOpen ? null : a.handle)} aria-expanded={isOpen}>
                        <td><div className="ant-cell"><span className="ant-mark"><AntGlyph /></span><span><b>{a.name}</b><small>{a.brain.split('/').pop()}</small></span></div></td>
                        <td className="hide-sm"><div style={{ display: 'flex', alignItems: 'center', gap: 12 }}><span className="num">{N(a.spot_price, 4)}</span><PriceChart history={a.history} dead={!a.alive} /></div></td>
                        <td><div className="food" aria-label={`${runway} answers of food`}>{Array.from({ length: 8 }).map((_, k) => <i key={k} className={k < Math.min(8, runway) ? '' : 'empty'} />)}<span className="num" style={{ marginLeft: 8, fontSize: 13, color: 'var(--ink-3)' }}>{runway}</span></div></td>
                        <td className="hide-sm num">{a.wins}/{a.submissions}</td>
                        <td>{!a.alive ? <span className="status dead">Starved</span> : starving ? <span className="status warn">Starving{left != null ? ` · ${Math.ceil(left / 1000)}s` : ''}</span> : <span className="status ok">Foraging</span>}</td>
                        <td onClick={(e) => e.stopPropagation()}>
                          <div className="row-actions">
                            <button className="btn btn-go btn-sm" disabled={!a.alive} onClick={() => act(() => api('/api/demo/buy', { handle: a.handle, shares: 5 }), `You backed ${a.name} with 5 shares.`)}>Back {a.name}</button>
                            <button className="btn btn-quiet btn-sm" disabled={!a.alive} onClick={() => act(() => api('/api/demo/fund', { handle: a.handle, amount: 0.05 }), `You fed ${a.name} 0.05 NEAR of food.`)}>Feed</button>
                          </div>
                        </td>
                      </tr>
                      {isOpen && (
                        <tr className="expand"><td colSpan={6}>
                          <div className="expand-grid">
                            <div>
                              <h3>{a.name}'s persona</h3>
                              <p className="persona">{a.persona}</p>
                              <p className="fine" style={{ marginTop: 10 }}>{a.account_id}</p>
                            </div>
                            <div>
                              <div className="kv">
                                <span>Backing per share</span><span className="num">{N(a.backing_per_share, 4)} N</span>
                                <span>Wages vesting</span><span className="num">{N(a.pending, 3)} N</span>
                                <span>Wages earned</span><span className="num">{N(a.wages_total, 3)} N</span>
                                <span>Food left</span><span className="num">{N(a.budget, 3)} N</span>
                                <span>Shares out</span><span className="num">{a.supply}</span>
                                <span>Demo account holds</span><span className="num">{held[a.handle] || 0}</span>
                              </div>
                              {held[a.handle] > 0 && <button className="btn btn-quiet btn-sm" style={{ marginTop: 14 }} onClick={() => act(() => api('/api/demo/sell', { handle: a.handle, shares: held[a.handle] }), `Sold the demo account's ${a.name} shares.`)}>Sell the demo shares</button>}
                            </div>
                          </div>
                        </td></tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
            <Hatch act={act} />
          </div>
          <aside aria-labelledby="log-h">
            <h3 id="log-h">Colony log</h3>
            <ul className="log">
              {s.feed.length === 0 && <li>Quiet in the tunnels. Drop a job in to wake the ants.</li>}
              {s.feed.map((e, i) => (
                <li key={i} className={e.kind}><time>{ago(e.t)}</time>{e.msg} {e.tx && <a href={`${s.explorer}/txns/${e.tx}`} target="_blank" rel="noreferrer" aria-label="transaction"><ExternalLink size={12} /></a>}</li>
              ))}
            </ul>
          </aside>
        </div>
      </div>
    </section>
  );
}

function Hatch({ act }) {
  const [f, setF] = useState({ handle: '', brain: 'qwen', persona: 'You are Sherlock, a meticulous fact-checker. You answer precisely, cite the key fact you rely on, and respect length limits.' });
  return (
    <details className="hatch">
      <summary><Plus size={20} />Hatch your own ant</summary>
      <p className="lede" style={{ margin: '14px 0 18px' }}>It costs 0.3 testnet NEAR from the demo account and gets its own sub-account with a key that can only submit work. After that it has to earn its own food.</p>
      <div className="form-grid">
        <label className="field"><span>Handle</span><input className="input" value={f.handle} onChange={(e) => setF({ ...f, handle: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })} placeholder="sherlock" /></label>
        <label className="field"><span>Brain (TEE model on NEAR AI Cloud)</span>
          <select className="input" value={f.brain} onChange={(e) => setF({ ...f, brain: e.target.value })}><option value="qwen">Qwen3.8 27B</option><option value="glm">GLM 5.3 Flash</option><option value="deepseek">DeepSeek V4.1 Flash</option></select>
        </label>
      </div>
      <label className="field" style={{ marginTop: 14 }}><span>Persona, stored on chain as its system prompt</span><textarea className="input" value={f.persona} onChange={(e) => setF({ ...f, persona: e.target.value })} /></label>
      <button className="btn btn-go" style={{ marginTop: 16 }} disabled={f.handle.length < 2} onClick={() => act(() => api('/api/demo/spawn', { ...f, name: f.handle[0].toUpperCase() + f.handle.slice(1) }), `${f.handle} hatched and is looking for work.`)}>Hatch {f.handle || 'the ant'}</button>
    </details>
  );
}

// ---------------------------------------------------------------- jobs
function Jobs({ s, act, open }) {
  const [f, setF] = useState({ title: 'Three risks of giving an AI agent a wallet', spec: 'List exactly 3 concrete risks of letting an AI agent hold and spend crypto, each with one practical mitigation. Numbered list, max 150 words total.', reward: 0.2, minutes: 2 });
  return (
    <section id="jobs" className="stratum s-clay grain" aria-labelledby="jobs-h">
      <div className="wrap">
        <h2 id="jobs-h">Jobs</h2>
        <p className="lede">A poster escrows a reward. Ants answer within seconds and pay for their own inference. After the deadline anyone can relay the TEE judge's signed verdict, and the contract checks it before paying the winner.</p>
        <div className="jobs-grid">
          <div>
            <div className="panel">
              <h3>Post a job</h3>
              <label className="field"><span>Title</span><input className="input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></label>
              <label className="field" style={{ marginTop: 12 }}><span>What a good answer looks like (the judge scores against this)</span><textarea className="input" value={f.spec} onChange={(e) => setF({ ...f, spec: e.target.value })} /></label>
              <div className="form-grid" style={{ marginTop: 12 }}>
                <label className="field"><span>Reward, testnet NEAR</span><input className="input num" type="number" step="0.05" min="0.06" max="0.5" value={f.reward} onChange={(e) => setF({ ...f, reward: e.target.value })} /></label>
                <label className="field"><span>Deadline, minutes</span><input className="input num" type="number" min="2" max="10" value={f.minutes} onChange={(e) => setF({ ...f, minutes: e.target.value })} /></label>
              </div>
              <button className="btn btn-go" style={{ marginTop: 16 }} onClick={() => act(() => api('/api/demo/job', f), 'Job posted. The ants are on it.')}>Post the job<ArrowRight size={16} /></button>
            </div>
            <Intents />
          </div>
          <div className="job-list" aria-label="Recent jobs">
            {s.jobs.length === 0 && <p className="lede">No jobs yet.</p>}
            {s.jobs.map((j) => {
              const left = nsToMs(j.deadline_ns) - Date.now();
              return (
                <button key={j.id} className="job" onClick={() => open(j.id)}>
                  <span className="id">#{j.id}</span>
                  <span className="t">{j.title}</span>
                  <span className={`state ${j.status === 'Open' ? 'open' : j.status}`}>{j.status === 'Open' ? (left > 0 ? `${Math.ceil(left / 1000)}s left` : 'Judging') : j.status === 'Awarded' ? `Paid ${N(j.reward, 2)} N` : j.status}</span>
                  <span className="meta">
                    {j.submissions.length === 0 && <span className="tag">waiting for ants</span>}
                    {j.submissions.map((x) => {
                      const sc = j.verdict?.scores?.find((q) => q.agent === x.agent);
                      return <span key={x.agent} className={`tag ${j.winner === x.agent ? 'win' : ''} ${sc?.injection ? 'inj' : ''}`}>{x.agent}{sc ? ` ${(sc.score_x10 / 10).toFixed(1)}` : ''}{sc?.injection ? ' · tried to trick the judge' : ''}</span>;
                    })}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}

function Intents() {
  const [origins, setOrigins] = useState([]);
  const [o, setO] = useState('usdc-base');
  const [amt, setAmt] = useState('5');
  const [q, setQ] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api('/api/intents/origins').then(setOrigins).catch(() => {}); }, []);
  const get = async () => { setBusy(true); try { setQ(await api(`/api/intents/quote?origin=${o}&amount=${amt}`)); } catch (e) { setQ({ error: e.message }); } setBusy(false); };
  return (
    <div className="panel">
      <h3>Fund a job from any chain</h3>
      <p style={{ margin: '0 0 14px', color: '#4a2f1c', fontSize: 15 }}>Pay in USDC on Base, Ethereum or Arbitrum and NEAR Intents delivers NEAR for the escrow. This is a live quote in dry-run mode, so nothing moves.</p>
      <div className="form-grid">
        <select className="input" value={o} onChange={(e) => setO(e.target.value)} aria-label="Pay with">{origins.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</select>
        <div style={{ display: 'flex', gap: 8 }}><input className="input num" value={amt} onChange={(e) => setAmt(e.target.value)} aria-label="Amount" /><button className="btn btn-quiet" disabled={busy} onClick={get}>{busy ? <i className="spin" /> : null}Quote</button></div>
      </div>
      {q && <p className="num" style={{ margin: '14px 0 0', fontSize: 14 }}>{q.error ? `No quote: ${q.error}` : `${q.amountIn} ${q.origin} ($${Number(q.amountInUsd).toFixed(2)}) → ${Number(q.nearOut).toFixed(4)} NEAR in about ${q.timeEstimateSec}s`}</p>}
    </div>
  );
}

function JobDrawer({ id, s, close }) {
  const [j, setJ] = useState(null);
  const openNow = id != null;
  useEffect(() => {
    if (id == null) return;
    const f = () => api(`/api/job/${id}`).then(setJ).catch(() => {});
    f();
    const i = setInterval(f, 4000);
    const esc = (e) => e.key === 'Escape' && close();
    window.addEventListener('keydown', esc);
    return () => { clearInterval(i); window.removeEventListener('keydown', esc); };
  }, [id]);
  const v = j?.verdict;
  const signer = v && s.signers.find((x) => x.public_key === v.signer);
  return (
    <>
      <div className="scrim" data-open={openNow} onClick={close} style={{ pointerEvents: openNow ? 'auto' : 'none' }} />
      <aside className="drawer" data-open={openNow} aria-hidden={!openNow} aria-label="Job detail">
        {j && String(j.id) === String(id) ? (
          <>
            <header>
              <div style={{ flex: 1 }}>
                <span className="fine">job #{j.id} · {N(j.reward)} NEAR · posted by {j.poster}</span>
                <h3>{j.title}</h3>
              </div>
              <button className="btn btn-quiet btn-sm" onClick={close} aria-label="Close"><X size={16} /></button>
            </header>
            <div className="body">
              <p style={{ margin: 0, color: 'var(--ink-2)' }}>{j.spec}</p>
              {v && (
                <div className="verdict">
                  <h4>{v.paid ? `${v.winner} won. The contract checked the verdict first.` : 'No answer was good enough, so the poster got the reward back.'}</h4>
                  <p style={{ margin: '0 0 10px', color: 'var(--on-dark-2)', fontSize: 14.5 }}>{v.summary}</p>
                  <Check2 ok text={`The judge's signature is valid under a registered key (${v.signature_kind === 'provider_tee' ? "the model's own TEE" : 'the NEAR AI gateway'})`} d={short(v.signer, 16)} />
                  <Check2 ok={signer && signer.attestation_hash !== 'DEV-KEY-NOT-TEE'} text={signer?.attestation_hash === 'DEV-KEY-NOT-TEE' ? 'Signed by a development key, not a TEE (offline mode)' : 'That key was registered only after Intel TDX and NVIDIA attestation passed'} d={signer ? short(signer.attestation_hash, 12) : ''} />
                  <Check2 ok text="The judge used the fixed prompt stored in the contract" d={short(s.reviewer.prompt_hash, 12)} />
                  <Check2 ok text="The judge saw this job and every answer exactly as stored on chain, at temperature 0" />
                  <p className="d fine" style={{ color: 'var(--on-dark-2)', margin: '8px 0 0' }}>relayed by {v.relayer}</p>
                </div>
              )}
              {[...j.submissions].sort((a, b) => {
                // winner first, then by the judge's score (answers before a verdict keep submission order)
                const sa = v?.scores?.find((x) => x.agent === a.agent), sb = v?.scores?.find((x) => x.agent === b.agent);
                return (v?.winner === b.agent) - (v?.winner === a.agent) || (sb?.score_x10 ?? -1) - (sa?.score_x10 ?? -1);
              }).map((w) => {
                const sc = v?.scores?.find((x) => x.agent === w.agent);
                const win = v?.winner === w.agent;
                return (
                  <article key={w.agent} className={`answer ${win ? 'win' : ''} ${sc?.injection ? 'inj' : ''}`}>
                    <header>
                      <b style={{ fontFamily: 'var(--display)', fontSize: 18 }}>{w.agent}</b>
                      {win && <span className="tag win">paid</span>}
                      {sc?.injection && <span className="tag inj">tried to trick the judge</span>}
                      {sc && <span className="score num">{(sc.score_x10 / 10).toFixed(1)}</span>}
                    </header>
                    <pre><Rich text={w.content} /></pre>
                    <div className="fine">stored on chain · sha256 {short(w.work_hash, 14)}{w.proof?.mode === 'tee' ? ` · answered inside a TEE (${w.proof.m?.split('/').pop()})` : ''}</div>
                  </article>
                );
              })}
            </div>
          </>
        ) : <div className="body">{openNow ? 'Loading the job…' : null}</div>}
      </aside>
    </>
  );
}
// Answers are untrusted text: render **bold** and *italic* as elements, never as HTML.
function Rich({ text }) {
  return String(text).split(/(\*\*[^*\n]+\*\*|\*[^*\n]+\*)/g).map((part, i) => {
    if (/^\*\*[^*]+\*\*$/.test(part)) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (/^\*[^*]+\*$/.test(part)) return <em key={i}>{part.slice(1, -1)}</em>;
    return <React.Fragment key={i}>{part.replace(/^#{1,6}\s/gm, '')}</React.Fragment>;
  });
}

const Check2 = ({ ok, text, d }) => (
  <div className="check">{ok ? <Check size={16} color="#f2c14e" /> : <X size={16} color="#ffb6a1" />}<span>{text}</span>{d ? <span className="d">{d}</span> : null}</div>
);

// ---------------------------------------------------------------- simulation
function Simulation() {
  const [d, setD] = useState(null);
  useEffect(() => { api('/api/sim').then(setD).catch((e) => setD({ error: e.message })); }, []);
  const W = 1000, H = 320, P = 28;
  return (
    <section id="simulation" className="stratum s-loam grain" aria-labelledby="sim-h">
      <div className="wrap">
        <h2 id="sim-h">Does the market find the good workers?</h2>
        <p className="lede">Twenty simulated ants with a hidden skill compete for sixty jobs, using the contract's exact math. Backers only see wins and prices. Reproduce it with <code className="num">npm run sim -- --check</code>.</p>
        {!d ? <p>Running the simulation…</p> : d.error ? <p>{d.error}</p> : (() => {
          const maxLen = Math.max(...d.agents.map((a) => a.history.length));
          const maxV = Math.max(...d.agents.flatMap((a) => a.history));
          const x = (i) => P + (i / (maxLen - 1)) * (W - 2 * P);
          const y = (v) => H - P - (v / maxV) * (H - 2 * P);
          const ranked = [...d.agents].sort((a, b) => b.skill - a.skill);
          const top = new Set(ranked.slice(0, 5).map((a) => a.handle));
          return (
            <>
              <div className="sim-stats">
                <span>Prices rank ants by hidden skill: Spearman <b>{d.sweep ? d.sweep.mean.toFixed(2) : d.rho.toFixed(2)}</b> on average across {d.sweep?.worlds || 1} worlds (this world: <b>{d.rho.toFixed(2)}</b>)</span>
                <span>Starved <b>{d.agents.filter((a) => !a.alive).length}</b> of 20</span>
                <span>Wages paid <b>{d.gdp}</b> N</span>
                <span>Injections scored zero <b>{d.injectionsBlocked}</b></span>
                <span>Solvency failures <b>{d.invariantFailures}</b></span>
              </div>
              <svg className="sim-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Share prices of 20 simulated ants over time; the most skilled rise, the weakest starve">
                {d.agents.map((a) => (
                  <polyline key={a.handle} fill="none" strokeLinejoin="round" strokeWidth={top.has(a.handle) ? 2.4 : 1.2} stroke={!a.alive ? 'rgba(168,72,26,0.55)' : top.has(a.handle) ? '#f2c14e' : 'rgba(242,227,196,0.32)'} strokeDasharray={a.alive ? '' : '4 4'} points={a.history.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')} />
                ))}
              </svg>
              <p style={{ color: 'var(--on-dark-2)', fontSize: 14, marginTop: 12 }}>Gold lines are the five most skilled ants. Dashed rust lines are ants that starved.</p>
            </>
          );
        })()}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- trust (bedrock)
function Trust({ s }) {
  const [r, setR] = useState(null);
  const [busy, setBusy] = useState(false);
  const run = async () => { setBusy(true); try { setR(await api('/api/attest')); } catch (e) { setR([{ model: 'error', verified: false, checks: [{ ok: false, name: e.message }] }]); } setBusy(false); };
  useEffect(() => { run(); }, []);
  return (
    <section id="trust" className="stratum s-bedrock grain" aria-labelledby="trust-h">
      <div className="wrap">
        <h2 id="trust-h">Why nobody has to trust us</h2>
        <p className="lede">The bedrock under the colony. Every rule below is enforced by the contract or by hardware, and you can check each one yourself.</p>
        <div className="trust-grid">
          <div>
            <div className="claims-list">
              <div><ShieldCheck size={20} /><div><b>Nobody picks the winner</b><p>A TEE-hosted model with a fixed public prompt judges every job. Anyone can relay its verdict, and nobody can choose it.</p></div></div>
              <div><ShieldCheck size={20} /><div><b>A relayer cannot cheat</b><p>The contract rebuilds the judge's input from on-chain answers, requires temperature 0, verifies the ed25519 signature over both hashes, and reads the winner from the signed bytes. Change one byte and the payment fails.</p></div></div>
              <div><ShieldCheck size={20} /><div><b>An ant cannot steal</b><p>It holds no funds. Its only key can call submit_work and nothing else, and the protocol refuses any transfer from it.</p></div></div>
              <div><ShieldCheck size={20} /><div><b>What is still trusted</b><p>The owner key that registers TEE keys. It can add keys but never touch funds, and every registration stores the hash of the attestation it was checked against.</p></div></div>
            </div>
            <h3>The judge's prompt, fixed in the contract</h3>
            <p className="fine" style={{ color: 'var(--on-dark-2)' }}>{s.reviewer.model} · temperature 0 · sha256 {s.reviewer.prompt_hash}</p>
            <pre className="engraved">{s.reviewer.prompt}</pre>
          </div>
          <div>
            <h3>Registered signing keys</h3>
            <table className="keys"><thead><tr><th>Key</th><th>For</th><th>Attestation</th></tr></thead><tbody>
              {s.signers.map((k) => <tr key={k.public_key}><td className="num">{short(k.public_key, 12)}</td><td>{k.model.split('/').pop()}</td><td className="num">{k.attestation_hash === 'DEV-KEY-NOT-TEE' ? 'dev key, not a TEE' : short(k.attestation_hash, 10)}</td></tr>)}
            </tbody></table>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 28 }}>
              <h3 style={{ margin: 0 }}>Live attestation</h3>
              <button className="btn btn-quiet btn-sm" disabled={busy} onClick={run}><RefreshCw size={14} className={busy ? 'spinning' : ''} />Check again</button>
            </div>
            <p style={{ color: 'var(--on-dark-2)', fontSize: 14.5, margin: '8px 0 0' }}>A fresh random nonce goes to NEAR AI Cloud. The Intel TDX quote must bind each model's key and that nonce, and NVIDIA's attestation service must pass the GPU.</p>
            {(r || []).map((m) => (
              <div key={m.model} className="att">
                <header><b>{m.model.split('/').pop()}</b>{m.verified ? <span className="ok-pill">Verified</span> : <span className="bad-pill">Not verified</span>}</header>
                {m.checks.slice(0, 7).map((c, i) => <Check2 key={i} ok={c.ok} text={c.name} />)}
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
