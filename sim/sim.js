#!/usr/bin/env node
// Offline simulation of an Antrepreneur colony. No keys, no network, no LLM.
//   npm run sim                 -> human-readable report
//   npm run sim -- --check      -> also asserts invariants, exits 1 on failure
//   npm run sim -- --json       -> writes sim/out.json
//   npm run sim -- --seed 7     -> different random world
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as M from './model.js';
import { runSim, summarize } from './engine.js';

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const r = runSim({ seed: Number(opt('--seed', 42)), agents: Number(opt('--agents', 20)), jobs: Number(opt('--jobs', 60)) });
const { cfg } = r;
const spark = (h) => { const bars = '▁▂▃▄▅▆▇█'; const step = Math.max(1, Math.floor(h.length / 40)); const pts = h.filter((_, i) => i % step === 0); const mx = Math.max(...pts), mn = Math.min(...pts); return pts.map((p) => bars[mx === mn ? 0 : Math.round(((p - mn) / (mx - mn)) * 7)]).join(''); };
const price = (a) => (a.alive ? Number(M.spotPrice(cfg, a)) : 0);

if (!flag('--quiet')) {
  console.log(`\nANTREPRENEUR SIMULATION  seed=${r.seed}  ants=${r.agents.length}  minutes=${r.minutes}\n`);
  console.log('ant         skill  alive  wins  bids  wages(N)  price(N)  backing/sh  food(N)   price path');
  for (const a of [...r.agents].sort((x, y) => price(y) - price(x))) {
    const bps = a.supply === 0n ? 0n : a.backing / a.supply;
    console.log(`${a.handle.padEnd(11)} ${a.skill.toFixed(2)}   ${a.alive ? 'yes' : 'DEAD'}  ${String(a.wins).padStart(4)}  ${String(a.submissions).padStart(4)}  ${M.fmt(a.wages_total).padStart(8)}  ${M.fmt(M.spotPrice(cfg, a), 4).padStart(8)}  ${M.fmt(bps, 4).padStart(10)}  ${M.fmt(a.budget).padStart(8)}  ${spark(a.history)}${a.attacker ? '  (injector)' : ''}`);
  }
  const dead = r.agents.filter((a) => !a.alive);
  console.log(`\nGDP (wages paid to ants): ${M.fmt(r.gdp)} NEAR`);
  console.log(`Inference paid by the ants themselves: ${M.fmt(r.inferenceOwed)} NEAR`);
  console.log(`Starved: ${dead.length} (${dead.map((a) => a.handle).join(', ') || 'none'})`);
  console.log(`Prompt-injection answers scored 0: ${r.injectionsBlocked}`);
  console.log(`Market efficiency: Spearman(hidden skill, final price) = ${r.rho.toFixed(2)}  (backers never see skill)`);
  console.log(`Solvency checks: ${r.minutes + 1} x ${r.agents.length} ants, failures: ${r.invariantFailures}\n`);
  if (flag('--verbose')) r.events.forEach((e) => console.log(`[t=${String(e.t).padStart(3)}m] ${e.m}`));
}
if (flag('--json')) {
  writeFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'out.json'), JSON.stringify(summarize(r), null, 1));
  console.log('wrote sim/out.json');
}
if (flag('--check')) {
  const fails = [];
  if (r.invariantFailures) fails.push(`${r.invariantFailures} solvency/supply invariant failures`);
  if (r.rho < 0.3) fails.push(`market did not track skill (rho=${r.rho.toFixed(2)})`);
  if (r.gdp === 0n) fails.push('no wages paid');
  if (fails.length) { console.error('CHECK FAILED:\n - ' + fails.join('\n - ')); process.exit(1); }
  console.log('CHECK PASSED: solvent at every step, supply conserved, prices track hidden skill, wages flowed.');
}
