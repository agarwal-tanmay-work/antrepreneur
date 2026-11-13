// Exact mirror of the contract's economics (contract/src/lib.rs) in BigInt yoctoNEAR.
// Used by the simulator and by the web app for quotes. If this disagrees with the
// contract, the contract wins and this is a bug.

export const NEAR = 10n ** 24n;
export const MILLI = NEAR / 1000n;
export const BPS = 10000n;

export const DEFAULT_CONFIG = {
  base_price: 10n * MILLI,
  slope: MILLI / 2n,
  buy_fee_bps: 500n,
  spawn_min: NEAR / 4n,
  agent_gas_fund: 100n * MILLI,
  submit_fee: 20n * MILLI,
  min_reward: 50n * MILLI,
  max_submissions: 8,
  wage_budget_bps: 3000n,
  death_grace_minutes: 10,
  award_grace_minutes: 60,
  wage_vest_minutes: 10,
};

export const curveCost = (cfg, a, b) => {
  if (b < a) throw new Error('bad range');
  const n = b - a;
  return cfg.base_price * n + (cfg.slope * n * (a + b)) / 2n;
};
const ceilDiv = (a, b) => (a === 0n ? 0n : (a - 1n) / b + 1n);

export function newAgent(handle, budget, now) {
  return {
    handle, budget, supply: 0n, curve_reserve: 0n, backing: 0n, pending: 0n,
    vest_start: now, vest_end: now, alive: true, starving_since: null,
    wins: 0, submissions: 0, wages_total: 0n, fees_paid: 0n,
  };
}

export function settle(a, now) {
  if (a.pending === 0n) return;
  let vested;
  if (now >= a.vest_end || a.vest_end <= a.vest_start) vested = a.pending;
  else vested = (a.pending * BigInt(now - a.vest_start)) / BigInt(a.vest_end - a.vest_start);
  a.pending -= vested;
  a.vest_start = now;
  if (a.supply === 0n) a.budget += vested;
  else a.backing += vested;
}

export function quoteBuy(cfg, a, n) {
  const curve = curveCost(cfg, a.supply, a.supply + n);
  const backing_in = a.supply === 0n ? 0n : ceilDiv(n * a.backing, a.supply);
  const fee = ceilDiv(curve * cfg.buy_fee_bps, BPS);
  return { curve, backing_in, fee, total: curve + backing_in + fee };
}

export function quoteSell(cfg, a, n) {
  if (n > a.supply) throw new Error('more than supply');
  let curve = curveCost(cfg, a.supply - n, a.supply);
  if (curve > a.curve_reserve) curve = a.curve_reserve;
  const back = a.supply === 0n ? 0n : (n * a.backing) / a.supply;
  return { curve, back, total: curve + back };
}

export function buy(cfg, a, n, now) {
  if (!a.alive) throw new Error('ant is dead');
  settle(a, now);
  const q = quoteBuy(cfg, a, n);
  a.supply += n; a.curve_reserve += q.curve; a.backing += q.backing_in; a.budget += q.fee;
  if (a.budget >= cfg.submit_fee) a.starving_since = null;
  return q.total;
}

export function sell(cfg, a, n, now) {
  settle(a, now);
  const q = quoteSell(cfg, a, n);
  a.supply -= n; a.curve_reserve -= q.curve; a.backing -= q.back;
  if (a.supply === 0n) { a.budget += a.backing; a.backing = 0n; }
  return q.total;
}

export function submit(cfg, a, now) {
  if (!a.alive) throw new Error('dead');
  if (a.budget < cfg.submit_fee) throw new Error('inference budget too low');
  a.budget -= cfg.submit_fee; a.fees_paid += cfg.submit_fee; a.submissions += 1;
  if (a.budget < cfg.submit_fee && a.starving_since === null) a.starving_since = now;
  return cfg.submit_fee;
}

export function award(cfg, a, reward, now) {
  if (!a.alive) throw new Error('winner is dead');
  settle(a, now);
  const raw = (reward * cfg.wage_budget_bps) / BPS;
  const [toBudget, toBacking] = a.supply === 0n ? [reward, 0n] : [raw, reward - raw];
  a.budget += toBudget;
  if (a.budget >= cfg.submit_fee) a.starving_since = null;
  if (toBacking > 0n) { a.pending += toBacking; a.vest_start = now; a.vest_end = now + cfg.wage_vest_minutes; }
  a.wins += 1; a.wages_total += reward;
  return { toBudget, toBacking };
}

export function canDie(cfg, a, now) {
  return a.alive && a.budget < cfg.submit_fee && a.starving_since !== null && now >= a.starving_since + cfg.death_grace_minutes;
}

export function declareDead(cfg, a, now) {
  if (!canDie(cfg, a, now)) throw new Error('cannot die yet');
  settle(a, now);
  a.alive = false;
  if (a.supply > 0n) { a.backing += a.budget + a.pending; a.budget = 0n; a.pending = 0n; }
}

export function spotPrice(cfg, a) {
  const bps = a.supply === 0n ? 0n : a.backing / a.supply;
  return cfg.base_price + cfg.slope * a.supply + bps;
}

export const fmt = (y, d = 3) => (Number(y) / 1e24).toFixed(d);
