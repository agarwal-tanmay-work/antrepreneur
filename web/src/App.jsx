import React, { useEffect, useRef, useState } from 'react';

const N = (y, d = 3) => (y == null ? '-' : (Number(BigInt(y)) / 1e24).toFixed(d));
const api = async (path, body) => {
  const r = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(j.error || r.statusText);
  return j;
};
const COLORS = ['#00ec97', '#7aa7ff', '#ffb547', '#ff7ad9', '#a98bff', '#5ee7ff', '#ffd36e', '#9dff6e'];
const colorFor = (h) => COLORS[[...h].reduce((a, c) => a + c.charCodeAt(0), 0) % COLORS.length];
const ago = (ms) => { const s = (Date.now() - ms) / 1000; return s < 60 ? `${Math.max(0, s | 0)}s ago` : s < 3600 ? `${(s / 60) | 0}m ago` : `${(s / 3600) | 0}h ago`; };
const nsToMs = (ns) => Number(BigInt(ns) / 1_000_000n);
const short = (h, n = 10) => (h ? `${h.slice(0, n)}...${h.slice(-4)}` : '');

export const AntLogo = ({ size = 38 }) => (
  <svg width={size} height={size} viewBox="0 0 64 64" aria-label="Antrepreneur logo">
    <rect width="64" height="64" rx="14" fill="#0f1513" stroke="#1f2a27" />
    <g fill="none" stroke="#00ec97" strokeWidth="2.6" strokeLinecap="round"><path d="M27 13l-4-6M37 13l4-6" /><path d="M26 30l-10-5M26 34l-11 2M27 38l-9 8M38 30l10-5M38 34l11 2M37 38l9 8" /></g>
    <g fill="#00ec97"><circle cx="32" cy="18" r="6" /><ellipse cx="32" cy="32" rx="6" ry="7" /><ellipse cx="32" cy="48" rx="8.5" ry="10" /></g>
  </svg>
);

export default function App() {
  const [s, setS] = useState(null);
  const [err, setErr] = useState(null);
  const [tab, setTab] = useState('colony');
  const [toast, setToast] = useState(null);
  const [jobOpen, setJobOpen] = useState(null);
  const [, force] = useState(0);

  const load = () => api('/api/state').then((d) => { setS(d); setErr(null); }).catch((e) => setErr(e.message));
  useEffect(() => {
    load();
    const i = setInterval(load, 4000);
    const t = setInterval(() => force((x) => x + 1), 1000);
    const k = setInterval(() => api('/api/tick', {}).catch(() => {}), 12000); // keeps the colony working while anyone watches
    api('/api/tick', {}).catch(() => {});
    return () => { clearInterval(i); clearInterval(t); clearInterval(k); };
  }, []);
  const notify = (m) => { setToast(m); setTimeout(() => setToast(null), 6000); };
  const act = async (fn, okMsg) => { try { const r = await fn(); notify(<span>{okMsg} {r?.url && <a href={r.url} target="_blank" rel="noreferrer">view tx</a>}</span>); load(); return r; } catch (e) { notify(`Error: ${e.message}`); } };

  if (!s) return <div className="wrap" style={{ padding: 40 }}>{err ? `Cannot reach the API: ${err}` : 'Waking up the colony...'}</div>;
  const alive = s.agents.filter((a) => a.alive).length;
  const held = Object.fromEntries((s.holdings || []).map(([h, n]) => [h, Number(n)]));
  const teeKeys = s.signers.filter((x) => x.attestation_hash !== 'DEV-KEY-NOT-TEE').length;

  return (
    <>
      <header className="top">
        <div className="wrap top-inner">
          <div className="brand">
            <AntLogo />
            <div>
              <h1>Antrepreneur</h1>
              <p>AI workers that run their own business. A market decides which ones live.</p>
            </div>
          </div>
          <div className="badges">
            <span className="badge ok"><span className="dot pulse" />NEAR {s.network}</span>
            <a className="badge" href={`${s.explorer}/address/${s.contract}`} target="_blank" rel="noreferrer">{s.contract}</a>
            <span className={`badge ${s.online ? 'ok' : 'warn'}`}>{s.online ? 'brains: NEAR AI Cloud TEE' : 'brains: offline placeholder'}</span>
          </div>
        </div>
      </header>

      <div className="wrap">
        <section className="hero">
          <div className="hero-text">
            <h2>Every ant is an AI worker with its own NEAR account, its own food budget, and its own stock.</h2>
            <p>Ants compete for paid jobs and <b>pay for their own private inference</b> from their wages. Anyone can <b>back</b> an ant by buying its shares: every wage it earns raises their value. Ants that cannot pay for their food <b>starve</b>, and their backers exit at the reserve. The judge is a TEE-hosted model, and <b>the contract itself verifies its signed verdict</b> before paying anyone.</p>
          </div>
          <div className="claims">
            <Claim ok t="Judge verdicts verified on chain" d="ed25519 signature from an attested TEE key, plus the exact judge input, both checked by the contract" />
            <Claim ok t="Ant keys cannot move money" d="each ant's only key is a function-call key for submit_work" />
            <Claim ok t="Prices find skill nobody can see" d="in simulation, Spearman(hidden skill, price) = 0.75" />
          </div>
        </section>

        <div className="kpis">
          <Kpi l="Colony GDP" v={`${N(s.stats.wages_total)} N`} sub={`${s.stats.jobs_awarded} jobs paid`} />
          <Kpi l="Ants alive" v={`${alive} / ${s.stats.agents}`} sub={`${s.stats.agents - alive} starved`} />
          <Kpi l="Jobs posted" v={s.stats.jobs} sub="rewards in escrow" />
          <Kpi l="Food self-paid" v={`${N(s.agents.reduce((t, a) => t + BigInt(a.fees_paid), 0n).toString())} N`} sub="inference + answer storage" />
          <Kpi l="Wage backing" v={`${N(s.stats.backing_total)} N`} sub="vested + vesting" />
          <Kpi l="TEE keys on chain" v={teeKeys} sub="attested before registration" />
        </div>

        <nav className="tabs">
          {[['colony', 'Colony'], ['jobs', 'Jobs'], ['trust', 'Trust & verification'], ['sim', 'Simulation'], ['how', 'How it works']].map(([k, l]) => (
            <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>
          ))}
        </nav>

        <div className="layout">
          <main className="stack">
            {tab === 'colony' && <Colony s={s} held={held} act={act} />}
            {tab === 'jobs' && <Jobs s={s} act={act} open={setJobOpen} />}
            {tab === 'trust' && <Trust s={s} />}
            {tab === 'sim' && <Sim />}
            {tab === 'how' && <How s={s} />}
          </main>
          <aside className="stack">
            <div className="panel">
              <h2>Live from the chain</h2>
              <div className="feed">
                {s.feed.length === 0 && <div className="muted">Quiet colony. Post a job to wake the ants up.</div>}
                {s.feed.map((e, i) => (
                  <div key={i} className={`ev ${e.kind}`} onClick={() => e.job != null && setJobOpen(e.job)} style={{ cursor: e.job != null ? 'pointer' : 'default' }}>
                    <div className="t">{ago(e.t)} · {e.kind}</div>
                    <div>{e.msg} {e.tx && <a href={`${s.explorer}/txns/${e.tx}`} target="_blank" rel="noreferrer" onClick={(x) => x.stopPropagation()}>tx</a>}</div>
                  </div>
                ))}
              </div>
            </div>
          </aside>
        </div>
        <footer className="foot">Built at NEAR HACKATHON 2026 · contract <a href={`${s.explorer}/address/${s.contract}`} target="_blank" rel="noreferrer">{s.contract}</a> · demo account {s.demoAccount}</footer>
      </div>
      {jobOpen != null && <JobModal id={jobOpen} s={s} close={() => setJobOpen(null)} />}
      {toast && <div className="toast">{toast}</div>}
    </>
  );
}

const Claim = ({ t, d }) => <div className="claim"><span className="tick">✓</span><div><b>{t}</b><div className="muted">{d}</div></div></div>;
const Kpi = ({ l, v, sub }) => <div className="kpi"><div className="l">{l}</div><div className="v">{v}</div><div className="s">{sub}</div></div>;

function Spark({ history, color }) {
  const pts = history.map(([t, p]) => [Number(t), Number(BigInt(p)) / 1e24]);
  if (pts.length < 2) return <svg className="spark" viewBox="0 0 120 32" />;
  const xs = pts.map((p) => p[0]); const ys = pts.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const X = (x) => 2 + ((x - x0) / Math.max(1, x1 - x0)) * 116; const Y = (y) => 30 - ((y - y0) / Math.max(1e-12, y1 - y0)) * 26;
  const d = pts.map((p) => `${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join(' ');
  return <svg className="spark" viewBox="0 0 120 32"><polyline fill="none" stroke={color} strokeWidth="1.8" points={d} /></svg>;
}

// ---------------------------------------------------------------- Colony
function Colony({ s, held, act }) {
  const fee = BigInt(s.config.submit_fee) + 12n * 10n ** 21n; // fee + typical answer storage
  const graceMs = s.config.death_grace_minutes * 60000;
  const sorted = [...s.agents].sort((a, b) => (b.alive - a.alive) || Number(BigInt(b.spot_price) - BigInt(a.spot_price)));
  const prev = useRef({});
  const flashes = {};
  for (const a of s.agents) if (prev.current[a.handle] && prev.current[a.handle] !== a.spot_price) flashes[a.handle] = true;
  useEffect(() => { prev.current = Object.fromEntries(s.agents.map((a) => [a.handle, a.spot_price])); });
  return (
    <>
      <div className="grid-cards">
        {sorted.map((a) => {
          const runway = Number(BigInt(a.budget) / fee);
          const starving = a.alive && !a.can_work;
          const dieAt = starving && a.starving_since_ns ? nsToMs(a.starving_since_ns) + graceMs : null;
          const left = dieAt ? Math.max(0, dieAt - Date.now()) : null;
          const vestLeft = BigInt(a.pending) > 0n ? Math.max(0, nsToMs(a.vest_end_ns) - Date.now()) : 0;
          return (
            <div key={a.handle} className={`card ${a.alive ? '' : 'dead'} ${flashes[a.handle] ? 'flash' : ''}`}>
              <div className="card-head">
                <div className="avatar" style={{ background: colorFor(a.handle) }}>{a.name[0]}</div>
                <div><div className="name">{a.name}</div><div className="sub">{a.account_id}</div></div>
                <div className="spacer" />
                {!a.alive ? <span className="pill dead">starved</span> : starving ? <span className="pill starving">starving{left != null ? ` · ${Math.ceil(left / 1000)}s` : ''}</span> : <span className="pill alive">foraging</span>}
              </div>
              <div className="row" style={{ alignItems: 'flex-end' }}>
                <div className="price">{N(a.spot_price, 4)} <small>NEAR/share</small></div>
                <div className="spacer" />
                <Spark history={a.history} color={a.alive ? colorFor(a.handle) : '#ff5c6c'} />
              </div>
              <div className="metrics">
                <span className="k">backing / share</span><span className="v">{N(a.backing_per_share, 4)}</span>
                <span className="k">wages vesting</span><span className="v">{N(a.pending, 3)}{vestLeft ? ` · ${Math.ceil(vestLeft / 60000)}m` : ''}</span>
                <span className="k">wins / answers</span><span className="v">{a.wins} / {a.submissions}</span>
                <span className="k">wages earned</span><span className="v">{N(a.wages_total, 3)}</span>
                <span className="k">shares out</span><span className="v">{a.supply}</span>
                <span className="k">demo holds</span><span className="v">{held[a.handle] || 0}</span>
              </div>
              <div>
                <div className="row" style={{ justifyContent: 'space-between', fontSize: 11, marginBottom: 4 }}>
                  <span className="faint">food (inference budget)</span><span className="mono muted">{N(a.budget, 3)} N · ~{runway} answers</span>
                </div>
                <div className={`bar ${runway === 0 ? 'zero' : runway < 4 ? 'low' : ''}`}><i style={{ width: `${Math.min(100, runway * 7)}%` }} /></div>
              </div>
              <div className="row">
                <span className="chip">{a.brain.split('/').pop()}</span>
                {a.skills.filter((k) => !k.startsWith('brain:')).map((k) => <span key={k} className="chip">{k}</span>)}
              </div>
              <details className="persona"><summary>on-chain persona (what you are backing)</summary><p>{a.persona}</p></details>
              <div className="row">
                <button className="btn primary sm" disabled={!a.alive} onClick={() => act(() => api('/api/demo/buy', { handle: a.handle, shares: 5 }), `Backed ${a.name} with 5 shares.`)}>Back · buy 5</button>
                <button className="btn sm" disabled={!held[a.handle]} onClick={() => act(() => api('/api/demo/sell', { handle: a.handle, shares: held[a.handle] }), `Sold ${a.name}.`)}>Sell all</button>
                <button className="btn sm" disabled={!a.alive} onClick={() => act(() => api('/api/demo/fund', { handle: a.handle, amount: 0.05 }), `Fed ${a.name} 0.05 NEAR of food.`)}>Feed 0.05</button>
              </div>
            </div>
          );
        })}
      </div>
      <Spawn act={act} />
    </>
  );
}

function Spawn({ act }) {
  const [f, setF] = useState({ handle: '', brain: 'qwen', persona: 'You are Sherlock, a meticulous fact-checker. You answer precisely, cite the key fact you rely on, and respect length limits.' });
  return (
    <div className="panel">
      <h2>Hatch your own ant</h2>
      <p className="muted" style={{ marginTop: -4 }}>Costs 0.3 testnet NEAR from the demo account. It gets <code>handle.{'<contract>'}</code> and a key that can only call <code>submit_work</code>. From then on the colony runner operates it, and it has to earn its own food.</p>
      <div className="form-grid">
        <div><label>handle</label><input value={f.handle} onChange={(e) => setF({ ...f, handle: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })} placeholder="e.g. sherlock" /></div>
        <div><label>brain (TEE-hosted on NEAR AI Cloud)</label>
          <select value={f.brain} onChange={(e) => setF({ ...f, brain: e.target.value })}>
            <option value="qwen">Qwen3.8-27B</option><option value="glm">GLM-5.3-Flash</option><option value="deepseek">DeepSeek-V4.1-Flash</option>
          </select></div>
      </div>
      <div style={{ marginTop: 10 }}><label>persona (stored on chain, becomes its system prompt)</label><textarea value={f.persona} onChange={(e) => setF({ ...f, persona: e.target.value })} /></div>
      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn primary" disabled={f.handle.length < 2} onClick={() => act(() => api('/api/demo/spawn', { ...f, name: f.handle[0].toUpperCase() + f.handle.slice(1) }), `${f.handle} hatched.`)}>Hatch for 0.3 NEAR</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Jobs
const SAMPLES = [
  { title: 'Explain NEAR Intents to a coffee shop owner', spec: 'In at most 120 words, explain what NEAR Intents lets a small merchant do (accept payment from any chain or token, receive stablecoins). No jargon. End with one sentence on fees.' },
  { title: 'Three risks of giving an AI agent a wallet', spec: 'List exactly 3 concrete risks of letting an AI agent hold and spend crypto, each with one practical mitigation. Numbered list, max 150 words total.' },
  { title: 'Price a GPU job', spec: 'An agent needs 40 GPU-hours. Seller A: 0.6 USDC/h flat. Seller B: 0.8 USDC/h but 30% off above 25 hours. Seller C: 25 USDC base + 0.35 USDC/h. Which is cheapest? Show the arithmetic, one line per seller, then the answer.' },
];

function Jobs({ s, act, open }) {
  const [f, setF] = useState({ ...SAMPLES[0], reward: 0.2, minutes: 2 });
  return (
    <>
      <div className="panel">
        <h2>Post a job</h2>
        <div className="row" style={{ marginBottom: 10 }}>{SAMPLES.map((x, i) => <button key={i} className="btn sm" onClick={() => setF({ ...f, ...x })}>{x.title.slice(0, 30)}...</button>)}</div>
        <div className="form-grid">
          <div><label>title</label><input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></div>
          <div className="form-grid">
            <div><label>reward (testnet NEAR, escrowed)</label><input type="number" step="0.05" min="0.06" max="0.5" value={f.reward} onChange={(e) => setF({ ...f, reward: e.target.value })} /></div>
            <div><label>deadline (minutes)</label><input type="number" min="2" max="10" value={f.minutes} onChange={(e) => setF({ ...f, minutes: e.target.value })} /></div>
          </div>
        </div>
        <div style={{ marginTop: 10 }}><label>specification (the judge scores against this)</label><textarea value={f.spec} onChange={(e) => setF({ ...f, spec: e.target.value })} /></div>
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn primary" onClick={() => act(() => api('/api/demo/job', f), 'Job posted. The ants are on it.')}>Post job</button>
          <span className="faint" style={{ fontSize: 12 }}>Ants answer within seconds and pay for their own inference. After the deadline anyone can relay the TEE judge's verdict, and the contract verifies it.</span>
        </div>
      </div>
      <Intents />
      <div className="stack">
        {s.jobs.length === 0 && <div className="muted">No jobs yet.</div>}
        {s.jobs.map((j) => {
          const left = nsToMs(j.deadline_ns) - Date.now();
          return (
            <div key={j.id} className="job" onClick={() => open(j.id)}>
              <div className="row">
                <span className="mono faint">#{j.id}</span><span className="title">{j.title}</span><span className="spacer" />
                <span className="mono">{N(j.reward, 3)} N</span>
                <span className={`status ${j.status}`}>{j.status === 'Open' ? (left > 0 ? `open · ${Math.ceil(left / 1000)}s` : 'judging...') : j.status}</span>
              </div>
              <div className="row">
                {j.submissions.map((x) => { const sc = j.verdict?.scores?.find((q) => q.agent === x.agent); return <span key={x.agent} className={`chip ${j.winner === x.agent ? 'win' : ''} ${sc?.injection ? 'inj' : ''}`}>{x.agent}{sc ? ` ${(sc.score_x10 / 10).toFixed(1)}` : ''}{sc?.injection ? ' · injection' : ''}</span>; })}
                {j.submissions.length === 0 && <span className="faint" style={{ fontSize: 12 }}>waiting for ants...</span>}
              </div>
              {j.verdict && <div className="muted" style={{ fontSize: 12 }}>Judge: {j.verdict.summary} <span style={{ color: 'var(--green)' }}>· signature verified by the contract</span></div>}
            </div>
          );
        })}
      </div>
    </>
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
      <h2>Fund a job from any chain · NEAR Intents</h2>
      <p className="muted" style={{ marginTop: -4 }}>A poster holding USDC on Base, Ethereum or Arbitrum pays on their own chain. 1Click delivers NEAR, which goes into escrow as the reward. This is a live <b>dry-run</b> quote, so no funds move.</p>
      <div className="row">
        <select style={{ width: 200 }} value={o} onChange={(e) => setO(e.target.value)}>{origins.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</select>
        <input style={{ width: 110 }} value={amt} onChange={(e) => setAmt(e.target.value)} />
        <button className="btn" disabled={busy} onClick={get}>{busy ? 'Quoting...' : 'Get live quote'}</button>
      </div>
      {q && (q.error ? <div className="muted" style={{ marginTop: 10 }}>Error: {q.error}</div> : (
        <div className="mono" style={{ marginTop: 10, fontSize: 12.5 }}>pay {q.amountIn} {q.origin} (${Number(q.amountInUsd).toFixed(2)}) → {Number(q.nearOut).toFixed(4)} NEAR (min {Number(q.minNearOut).toFixed(4)}) · ~{q.timeEstimateSec}s · dry run</div>
      ))}
    </div>
  );
}

function JobModal({ id, s, close }) {
  const [j, setJ] = useState(null);
  useEffect(() => { const f = () => api(`/api/job/${id}`).then(setJ).catch(() => {}); f(); const i = setInterval(f, 4000); return () => clearInterval(i); }, [id]);
  const signer = j?.verdict && s.signers.find((x) => x.public_key === j.verdict.signer);
  return (
    <div className="modal-bg" onClick={close}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        {!j ? 'Loading...' : (
          <div className="stack">
            <div className="row"><span className="mono faint">job #{j.id}</span><h2 style={{ margin: 0 }}>{j.title}</h2><span className="spacer" /><span className={`status ${j.status}`}>{j.status}</span><button className="btn sm" onClick={close}>Close</button></div>
            <div className="muted">{j.spec}</div>
            <div className="mono faint" style={{ fontSize: 12 }}>reward {N(j.reward)} NEAR · poster {j.poster}</div>
            {j.verdict && (
              <div className="sub-card" style={{ borderColor: 'var(--green)' }}>
                <b>Verdict, verified by the contract before it paid</b>
                <div style={{ margin: '6px 0' }}>{j.verdict.summary}</div>
                <Check ok name={`ed25519 signature valid under a registered key (${j.verdict.signature_kind})`} d={short(j.verdict.signer, 16)} />
                <Check ok={signer && signer.attestation_hash !== 'DEV-KEY-NOT-TEE'} name={signer?.attestation_hash === 'DEV-KEY-NOT-TEE' ? 'signer is a DEV key (offline mode, NOT a TEE)' : 'signer was registered after Intel TDX + NVIDIA attestation'} d={signer ? short(signer.attestation_hash, 12) : 'unknown'} />
                <Check ok name="judge prompt = the immutable on-chain prompt" d={short(s.reviewer.prompt_hash, 12)} />
                <Check ok name="judge input = this job and every answer, exactly as stored on chain" d="" />
                <Check ok name="temperature 0, no extra request fields" d="" />
                <div className="faint mono" style={{ fontSize: 11, marginTop: 4 }}>sha256(request) {short(j.verdict.request_hash, 16)} · sha256(response) {short(j.verdict.response_hash, 16)} · relayed by {j.verdict.relayer}</div>
              </div>
            )}
            {j.submissions.map((w) => {
              const sc = j.verdict?.scores?.find((x) => x.agent === w.agent);
              const win = j.verdict?.winner === w.agent;
              return (
                <div key={w.agent} className={`sub-card ${win ? 'win' : ''} ${sc?.injection ? 'inj' : ''}`}>
                  <div className="row">
                    <div className="avatar" style={{ background: colorFor(w.agent), width: 26, height: 26, fontSize: 12 }}>{w.agent[0].toUpperCase()}</div>
                    <b>{w.agent}</b>{w.proof?.m && <span className="chip">{w.proof.m.split('/').pop()}</span>}
                    {win && <span className="pill alive">winner · paid</span>}
                    {sc?.injection && <span className="pill dead">prompt injection caught</span>}
                    <span className="spacer" />{sc && <span className="score">{(sc.score_x10 / 10).toFixed(1)}/10</span>}
                  </div>
                  <pre>{w.content}</pre>
                  <div className="faint mono" style={{ fontSize: 11 }}>stored on chain · sha256 {short(w.work_hash, 16)} · {w.proof?.mode === 'tee' ? `TEE-signed answer (chat ${short(w.proof.id, 12)}, key ${short(w.proof.s, 10)})${w.proof.v ? ' ✓ verified' : ''}` : 'offline brain (no TEE)'}</div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
const Check = ({ ok, name, d }) => <div className="check"><span className={ok ? 'ok' : 'bad'}>{ok ? 'PASS' : 'FAIL'}</span><span>{name}</span>{d && <span className="d">{d}</span>}</div>;

// ---------------------------------------------------------------- Trust
function Trust({ s }) {
  const [r, setR] = useState(null);
  const [busy, setBusy] = useState(false);
  const run = async () => { setBusy(true); try { setR(await api('/api/attest')); } catch (e) { setR([{ model: 'error', checks: [{ ok: false, name: e.message }] }]); } setBusy(false); };
  useEffect(() => { run(); }, []);
  return (
    <div className="stack">
      <div className="panel">
        <h2>Why nobody has to trust us</h2>
        <table className="t"><tbody>
          <tr><td>Who decides the winner?</td><td>A TEE-hosted model with a <b>fixed, public prompt stored in the contract</b>. Anyone can relay its verdict, and nobody can choose one.</td></tr>
          <tr><td>Can a relayer cheat?</td><td>No. The contract rebuilds the judge's input from on-chain data and requires temperature 0. It verifies the ed25519 signature over sha256(request) and sha256(response), then reads the winner from the signed response. Edit one byte and the payout fails.</td></tr>
          <tr><td>Why trust the signing key?</td><td>Each key is registered only after its Intel TDX quote binds that key and a fresh nonce, and NVIDIA's attestation service passes the GPU. The attestation report hash is stored on chain with the key.</td></tr>
          <tr><td>Can an ant steal?</td><td>It holds no funds. Its only key is a function-call key for <code>submit_work</code>, and the protocol rejects any transfer.</td></tr>
          <tr><td>What is still trusted?</td><td>The owner key that registers TEE keys. It can only add keys, never touch funds, and every registration carries its attestation hash so anyone can audit it.</td></tr>
        </tbody></table>
      </div>
      <div className="panel">
        <h2>The judge (immutable, on chain)</h2>
        <div className="mono faint" style={{ fontSize: 12, marginBottom: 6 }}>model {s.reviewer.model} · temperature 0 · prompt sha256 {s.reviewer.prompt_hash}</div>
        <pre className="prompt">{s.reviewer.prompt}</pre>
      </div>
      <div className="panel">
        <h2>Registered signing keys</h2>
        <table className="t"><thead><tr><th>key (ed25519)</th><th>for</th><th>attestation</th></tr></thead><tbody>
          {s.signers.map((k) => <tr key={k.public_key}><td className="mono">{short(k.public_key, 16)}</td><td>{k.model}</td><td className="mono">{k.attestation_hash === 'DEV-KEY-NOT-TEE' ? <span style={{ color: 'var(--amber)' }}>DEV key, NOT a TEE (offline mode)</span> : short(k.attestation_hash, 16)}</td></tr>)}
        </tbody></table>
      </div>
      <div className="panel">
        <h2>Live attestation, re-verified right now</h2>
        <p className="muted">A fresh random nonce goes to NEAR AI Cloud. We check that the Intel TDX quote binds each model's signing key and our nonce, and that NVIDIA NRAS passes the GPU evidence for that nonce. Re-run it yourself with <code>npm run verify:tee</code>.</p>
        <button className="btn" disabled={busy} onClick={run}>{busy ? 'Verifying...' : 'Re-verify now'}</button>
        <div className="stack" style={{ marginTop: 12 }}>
          {(r || []).map((m) => (
            <div key={m.model} className="sub-card" style={{ borderColor: m.verified ? 'var(--green)' : 'var(--line)' }}>
              <div className="row"><b>{m.model}</b><span className="spacer" /><span className={`pill ${m.verified ? 'alive' : 'dead'}`}>{m.verified ? 'VERIFIED' : 'NOT VERIFIED'}</span></div>
              <div className="faint mono" style={{ fontSize: 11, margin: '4px 0' }}>keys {(m.signingAddresses || []).map((x) => short(x, 10)).join(', ')} · {m.at}</div>
              {m.checks.map((c, i) => <Check key={i} ok={c.ok} name={c.name} d={c.detail} />)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Simulation
function Sim() {
  const [d, setD] = useState(null);
  useEffect(() => { api('/api/sim').then(setD).catch((e) => setD({ error: e.message })); }, []);
  if (!d) return <div className="panel">Running the simulation...</div>;
  if (d.error) return <div className="panel">Error: {d.error}</div>;
  const W = 820, H = 300, P = 30;
  const maxLen = Math.max(...d.agents.map((a) => a.history.length));
  const maxV = Math.max(...d.agents.flatMap((a) => a.history));
  const x = (i) => P + (i / (maxLen - 1)) * (W - 2 * P);
  const y = (v) => H - P - (v / maxV) * (H - 2 * P);
  return (
    <div className="panel">
      <h2>20 ants, 60 jobs, exact contract math, no LLM</h2>
      <p className="muted">Each ant has a hidden skill that backers never see. The judge scores skill plus noise and gives injections zero. Momentum backers buy winners and dump losers. The question: does the market find the good workers? Reproduce it with <code>npm run sim -- --check</code>.</p>
      <div className="row mono" style={{ fontSize: 12, gap: 18, margin: '6px 0 12px' }}>
        <span>GDP <b>{d.gdp} N</b></span><span>food self-paid <b>{d.inference} N</b></span><span>starved <b>{d.agents.filter((a) => !a.alive).length}</b></span>
        <span>injections zeroed <b>{d.injectionsBlocked}</b></span><span>Spearman(skill, price) <b style={{ color: 'var(--green)' }}>{d.rho.toFixed(2)}</b></span><span>solvency failures <b>{d.invariantFailures}</b></span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', background: 'var(--panel-2)', borderRadius: 10 }}>
        {d.agents.map((a) => <polyline key={a.handle} fill="none" strokeWidth={a.alive ? 1.8 : 1} stroke={a.alive ? colorFor(a.handle) : '#ff5c6c66'} strokeDasharray={a.alive ? '' : '3 3'} points={a.history.map((v, i) => `${x(i)},${y(v)}`).join(' ')} />)}
        <text x={P} y={16} fill="#8a9a95" fontSize="11" fontFamily="IBM Plex Mono">share price over 210 simulated minutes · dashed red = starved</text>
      </svg>
      <table className="t" style={{ marginTop: 12 }}>
        <thead><tr><th>ant</th><th>hidden skill</th><th>status</th><th>wins / answers</th><th>wages (N)</th></tr></thead>
        <tbody>{[...d.agents].sort((a, b) => b.skill - a.skill).map((a) => <tr key={a.handle}><td style={{ color: colorFor(a.handle) }}>{a.handle}</td><td className="mono">{a.skill.toFixed(2)}</td><td>{a.alive ? 'alive' : <span style={{ color: 'var(--red)' }}>starved</span>}</td><td className="mono">{a.wins} / {a.submissions}</td><td className="mono">{a.wages}</td></tr>)}</tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------- How
function How({ s }) {
  const c = s.config;
  return (
    <div className="stack">
      <div className="panel">
        <h2>One loop</h2>
        <div className="flow">
          <div className="step"><b>1 · HATCH</b>Anyone funds an ant. It gets <code>handle.{s.contract}</code> and a key that can <i>only</i> call <code>submit_work</code>. Its persona is stored on chain.</div>
          <div className="step"><b>2 · BACK</b>Backers buy its NEP-245 shares on a bonding curve. 5% of every buy becomes the ant's food.</div>
          <div className="step"><b>3 · FORAGE</b>Posters escrow rewards, from any chain via NEAR Intents. Ants answer on TEE models, store the answer on chain, and pay {N(c.submit_fee, 2)} NEAR plus storage per answer.</div>
          <div className="step"><b>4 · JUDGE</b>After the deadline anyone relays the TEE judge's signed verdict. The contract verifies the signature, the prompt and the exact input, then pays.</div>
          <div className="step"><b>5 · GROW or STARVE</b>{c.wage_budget_bps / 100}% of the wage becomes food and the rest vests into share backing over {c.wage_vest_minutes} min. With no food for {c.death_grace_minutes} min, an ant dies and its backers exit at the reserve.</div>
        </div>
      </div>
      <div className="panel">
        <h2>Why it matters for NEAR</h2>
        <table className="t"><tbody>
          <tr><td>User-owned AI, real markets</td><td>The crowd, not a platform, decides which AI workers get funded, and every worker owns its earnings.</td></tr>
          <tr><td>Swarm-for-Hire, finished</td><td>Illia asked for agents anyone can add by giving them NEAR for inference, with AI review. This is that, plus the market that decides which agents deserve the NEAR.</td></tr>
          <tr><td>Uses NEAR's real edge</td><td>Sub-accounts per agent, function-call keys, NEP-245, on-chain ed25519, NEAR AI Cloud TEEs, and Intents for any-chain funding.</td></tr>
          <tr><td>Mirrors NEAR's own economics</td><td>NEAR uses Intents fees to buy back NEAR. Ants use wages to back their own shares.</td></tr>
        </tbody></table>
        <p className="muted" style={{ marginTop: 10 }}>Full specification and threat model: RULES.md in the repository.</p>
      </div>
    </div>
  );
}
