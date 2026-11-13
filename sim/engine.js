// Simulation engine: a colony of ants with hidden skill competes for paid jobs,
// scripted backers trade their shares, and the exact contract math
// (sim/model.js) is applied. Solvency and supply are checked every minute.
import * as M from './model.js';

const NAMES = ['scout', 'quill', 'ledger', 'atlas', 'ember', 'vector', 'sage', 'pixel', 'rune', 'cipher', 'nova', 'drift', 'echo', 'flint', 'gale', 'harbor', 'iris', 'juno', 'kite', 'lumen', 'moss', 'nimbus', 'onyx', 'pike'];

export function runSim({ seed = 42, agents: AGENTS = 20, jobs: JOBS = 60 } = {}) {
  let s = seed >>> 0;
  const rnd = () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const near = (x) => BigInt(Math.round(x * 1000)) * M.MILLI;
  const cfg = M.DEFAULT_CONFIG;

  let now = 0;
  let contractBalance = 0n;
  let inferenceOwed = 0n;
  let gdp = 0n;
  let invariantFailures = 0;
  let injectionsBlocked = 0;
  const events = [];
  const log = (m) => events.push({ t: now, m });

  const agents = [];
  for (let i = 0; i < AGENTS; i++) {
    const deposit = near(0.25 + rnd() * 0.35);
    const budget = deposit - cfg.agent_gas_fund;
    contractBalance += budget;
    const a = M.newAgent(NAMES[i % NAMES.length] + (i >= NAMES.length ? i : ''), budget, now);
    a.skill = 0.2 + rnd() * 0.75;
    a.attacker = i === 3 || i === 11;
    a.recent = [];
    a.history = [];
    agents.push(a);
  }
  const backers = Array.from({ length: 12 }, (_, i) => ({ id: `backer${i}`, cash: near(20), holdings: new Map(), style: i < 8 ? 'momentum' : 'random' }));

  const checkSolvency = () => {
    let owed = inferenceOwed;
    for (const a of agents) {
      if (a.curve_reserve !== M.curveCost(cfg, 0n, a.supply)) { invariantFailures++; log(`INVARIANT FAIL curve ${a.handle}`); }
      owed += a.curve_reserve + a.backing + a.pending + a.budget;
      const held = backers.reduce((acc, b) => acc + (b.holdings.get(a.handle) || 0n), 0n);
      if (held !== a.supply) { invariantFailures++; log(`INVARIANT FAIL supply ${a.handle}`); }
    }
    if (owed > contractBalance) { invariantFailures++; log('INVARIANT FAIL insolvent'); }
  };
  const doBuy = (b, a, n) => {
    if (!a.alive) return;
    M.settle(a, now);
    if (M.quoteBuy(cfg, a, n).total > b.cash) return;
    const paid = M.buy(cfg, a, n, now);
    b.cash -= paid; contractBalance += paid;
    b.holdings.set(a.handle, (b.holdings.get(a.handle) || 0n) + n);
  };
  const doSell = (b, a, n) => {
    const have = b.holdings.get(a.handle) || 0n;
    if (have < n || n === 0n) return;
    const got = M.sell(cfg, a, n, now);
    b.cash += got; contractBalance -= got;
    b.holdings.set(a.handle, have - n);
  };
  const winRate = (a) => (a.recent.length ? a.recent.reduce((x, y) => x + y, 0) / a.recent.length : 0);

  const minutes = JOBS * 3 + 30;
  for (now = 0; now <= minutes; now++) {
    if (now % 3 === 0 && now / 3 < JOBS) {
      const reward = near(0.2 + rnd() * 0.8);
      contractBalance += reward;
      const able = agents.filter((a) => a.alive && a.budget >= cfg.submit_fee && rnd() < 0.7);
      able.sort(() => rnd() - 0.5);
      const subs = able.slice(0, cfg.max_submissions);
      let best = null;
      let bestScore = -1;
      for (const a of subs) {
        inferenceOwed += M.submit(cfg, a, now);
        const injected = a.attacker && rnd() < 0.8;
        const score = injected ? 0 : Math.max(0, a.skill + gauss() * 0.15);
        if (injected) injectionsBlocked++;
        if (score > bestScore) { bestScore = score; best = a; }
      }
      for (const a of subs) { a.recent.push(a === best && bestScore > 0.25 ? 1 : 0); if (a.recent.length > 10) a.recent.shift(); }
      if (best && bestScore > 0.25) {
        const w = M.award(cfg, best, reward, now);
        gdp += reward;
        log(`job ${now / 3}: ${best.handle} wins ${M.fmt(reward)} NEAR (${subs.length} bids) -> food +${M.fmt(w.toBudget)}, backing +${M.fmt(w.toBacking)}`);
      } else {
        contractBalance -= reward;
        log(`job ${now / 3}: no acceptable answer, poster refunded`);
      }
    }
    if (now % 5 === 1) {
      for (const b of backers) {
        if (b.style === 'momentum') {
          const ranked = agents.filter((a) => a.alive).sort((x, y) => winRate(y) - winRate(x));
          if (ranked[0] && winRate(ranked[0]) > 0) doBuy(b, ranked[0], BigInt(1 + Math.floor(rnd() * 8)));
          for (const [h, n] of b.holdings) {
            const a = agents.find((x) => x.handle === h);
            if (n > 0n && (!a.alive || (a.recent.length >= 4 && winRate(a) === 0))) doSell(b, a, n);
          }
        } else if (rnd() < 0.5) {
          const a = pick(agents.filter((x) => x.alive));
          if (a) doBuy(b, a, BigInt(1 + Math.floor(rnd() * 4)));
        }
      }
    }
    for (const a of agents) if (M.canDie(cfg, a, now)) { M.declareDead(cfg, a, now); log(`DEATH: ${a.handle} starved`); }
    for (const a of agents) { M.settle(a, now); a.history.push(Number(M.spotPrice(cfg, a)) / 1e24); }
    checkSolvency();
  }

  const rank = (xs) => { const idx = xs.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]); const r = Array(xs.length); idx.forEach(([, i], k) => (r[i] = k)); return r; };
  const spearman = (xs, ys) => { const rx = rank(xs), ry = rank(ys), n = xs.length; const d2 = rx.reduce((acc, r, i) => acc + (r - ry[i]) ** 2, 0); return 1 - (6 * d2) / (n * (n * n - 1)); };
  const rho = spearman(agents.map((a) => a.skill), agents.map((a) => (a.alive ? Number(M.spotPrice(cfg, a)) : 0)));
  return { seed, minutes, gdp, inferenceOwed, rho, injectionsBlocked, invariantFailures, agents, events, cfg };
}

export function summarize(r) {
  return {
    seed: r.seed, minutes: r.minutes, gdp: M.fmt(r.gdp), inference: M.fmt(r.inferenceOwed), rho: r.rho, injectionsBlocked: r.injectionsBlocked, invariantFailures: r.invariantFailures,
    agents: r.agents.map((a) => ({ handle: a.handle, skill: a.skill, alive: a.alive, wins: a.wins, submissions: a.submissions, wages: M.fmt(a.wages_total), history: a.history.filter((_, i) => i % 3 === 0) })),
    events: r.events.slice(-200),
  };
}
