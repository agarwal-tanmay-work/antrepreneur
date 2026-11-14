import React, { useEffect, useMemo, useRef } from 'react';

// The live colony, drawn as a glass ant farm in cross-section.
// Truth rules: an ant stands in the job chamber only if it really answered the
// open job; food (seeds) is its real budget; a starved ant is a fossil.
// Motion: an ant walks its tunnel when its on-chain state changes; the winner of
// a job carries seeds home. Under reduced motion everything moves instantly.

const W = 1000;
const H = 640;
const JOB = { x: 560, y: 132 };
const nsToMs = (ns) => Number(BigInt(ns) / 1_000_000n);

function layout(n) {
  if (n === 0) return [];
  if (n <= 4) return Array.from({ length: n }, (_, i) => ({ x: n === 1 ? W / 2 : 120 + (i * (W - 240)) / (n - 1), y: 430 }));
  // five or more: zig-zag between two rows, so every tunnel runs in the gap between
  // the chambers above it instead of through one of them
  return Array.from({ length: n }, (_, i) => ({ x: 100 + (i * (W - 200)) / (n - 1), y: i % 2 ? 530 : 350 }));
}

// sideways in the open band above the chambers, then straight down: no tunnel ever crosses a chamber
const tunnel = (c) => `M ${JOB.x} ${JOB.y + 40} C ${JOB.x} ${JOB.y + 112}, ${c.x} ${JOB.y + 84}, ${c.x} ${JOB.y + 168} L ${c.x} ${c.y - 18}`;

function AntShape() {
  return (
    <g className="ant-body">
      <g className="legs" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" fill="none">
        <path className="leg l1" d="M-1 -1 L-5 -7 M-1 1 L-5 7" />
        <path className="leg l2" d="M2 -1 L1 -8 M2 1 L1 8" />
        <path className="leg l3" d="M4 -1 L8 -7 M4 1 L8 7" />
      </g>
      <path d="M10 -1 Q14 -6 16 -6 M10 1 Q14 6 16 6" stroke="currentColor" strokeWidth="1.1" fill="none" strokeLinecap="round" />
      <ellipse cx="-7" cy="0" rx="5.4" ry="3.8" fill="currentColor" />
      <ellipse cx="1.8" cy="0" rx="3.2" ry="2.3" fill="currentColor" />
      <circle cx="8.4" cy="0" r="2.8" fill="currentColor" />
    </g>
  );
}

export default function AntFarm({ agents, jobs, config, onPick }) {
  const reduce = useMemo(() => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches, []);
  const shown = useMemo(() => [...agents].sort((a, b) => Number(a.created_ns) - Number(b.created_ns)).slice(0, 9), [agents]);
  const spots = useMemo(() => layout(shown.length), [shown.length]);
  const fee = BigInt(config.submit_fee) + 12n * 10n ** 21n;
  const open = jobs.find((j) => j.status === 'Open');
  const atJob = new Set(open ? open.submissions.map((s) => s.agent) : []);
  const lastPaid = jobs.find((j) => j.verdict?.paid);

  const pathRefs = useRef({});
  const antRefs = useRef({});
  const anim = useRef({}); // handle -> { from, to, start, dur, carrying }
  const where = useRef({}); // handle -> 'home' | 'job'
  const seen = useRef({ init: false, paid: new Set() });

  // decide targets; start walks when truth changes
  useEffect(() => {
    const now = performance.now();
    const paidNow = new Set(jobs.filter((j) => j.verdict?.paid).map((j) => `${j.id}:${j.verdict.winner}`));
    shown.forEach((a, i) => {
      const target = a.alive && atJob.has(a.handle) ? 'job' : 'home';
      const prev = where.current[a.handle];
      const wonNow = [...paidNow].some((k) => k.endsWith(`:${a.handle}`) && !seen.current.paid.has(k));
      if (prev === undefined || !seen.current.init) {
        where.current[a.handle] = target;
        anim.current[a.handle] = { at: target === 'job' ? 0 : 1 };
      } else if (prev !== target) {
        where.current[a.handle] = target;
        anim.current[a.handle] = { from: prev === 'job' ? 0 : 1, to: target === 'job' ? 0 : 1, start: now + i * 90, dur: reduce ? 0 : 2200, carrying: target === 'home' && wonNow };
      }
    });
    seen.current.paid = paidNow;
    seen.current.init = true;
  });

  // one rAF loop moves every ant along its own tunnel (no React renders per frame)
  useEffect(() => {
    let raf;
    const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
    const tick = (now) => {
      shown.forEach((a, i) => {
        const g = antRefs.current[a.handle];
        const p = pathRefs.current[a.handle];
        const s = anim.current[a.handle];
        if (!g || !p || !s) return;
        const len = p.getTotalLength();
        let u;
        let moving = false;
        if (s.at !== undefined) u = s.at;
        else {
          const k = Math.min(1, Math.max(0, (now - s.start) / (s.dur || 1)));
          u = s.from + (s.to - s.from) * ease(k);
          moving = k > 0 && k < 1;
          if (k >= 1) anim.current[a.handle] = { at: s.to, carried: s.carrying, carriedAt: now };
        }
        const pt = p.getPointAtLength(u * len);
        const ahead = p.getPointAtLength(Math.min(len, Math.max(0, u * len + (s.to === 1 || s.at === 1 ? 2 : -2))));
        let x = pt.x;
        let y = pt.y;
        let ang = (Math.atan2(ahead.y - pt.y, ahead.x - pt.x) * 180) / Math.PI;
        const resting = !moving;
        if (resting && !reduce && a.alive) {
          // idle: a slow amble inside the chamber (decorative, only while resting)
          const phase = now / 2600 + i * 1.7;
          const span = u === 0 ? 34 + i * 5 : 26;
          const baseY = u === 0 ? JOB.y + 8 + (i % 3) * 7 : spots[i].y + 4;
          const baseX = u === 0 ? JOB.x - 70 + ((i * 37) % 140) : spots[i].x;
          x = baseX + Math.sin(phase) * span;
          y = baseY + Math.sin(phase * 2.1) * 2;
          ang = Math.cos(phase) >= 0 ? 0 : 180;
        } else if (resting && u === 0) {
          x = JOB.x - 70 + ((i * 37) % 140);
          y = JOB.y + 8 + (i % 3) * 7;
          ang = 0;
        } else if (resting) {
          x = spots[i].x;
          y = spots[i].y + 4;
          ang = 0;
        }
        g.setAttribute("transform", `translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${ang.toFixed(1)}) scale(1.6)`);
        g.classList.toggle('walking', moving || (resting && !reduce && a.alive));
        const cur = anim.current[a.handle];
        const seed = g.querySelector('.carry');
        if (seed) seed.style.opacity = (s.carrying && moving) || (cur.carried && now - cur.carriedAt < 1400) ? '1' : '0';
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [shown, spots, reduce]);

  const left = open ? Math.max(0, nsToMs(open.deadline_ns) - Date.now()) : 0;
  const title = open ? (open.title.length > 34 ? `${open.title.slice(0, 33)}…` : open.title) : null;

  return (
    <figure className="farm" aria-label="Live colony: each ant is an AI worker on NEAR">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-hidden="false">
        <defs>
          <filter id="grain" x="0" y="0" width="100%" height="100%">
            <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" stitchTiles="stitch" />
            <feColorMatrix values="0 0 0 0 0.35  0 0 0 0 0.22  0 0 0 0 0.1  0 0 0 0.16 0" />
          </filter>
          <radialGradient id="chamberShade" cx="50%" cy="35%" r="70%">
            <stop offset="0%" stopColor="#6B4628" />
            <stop offset="100%" stopColor="#3B2414" />
          </radialGradient>
        </defs>

        {/* strata */}
        <path d={`M0 210 C 200 196, 380 230, 1000 204 L1000 ${H} L0 ${H} Z`} fill="#DDBE84" opacity="0.55" />
        <path d={`M0 470 C 260 452, 640 492, 1000 462 L1000 ${H} L0 ${H} Z`} fill="#D2AD71" opacity="0.6" />
        <rect width={W} height={H} filter="url(#grain)" />

        {/* surface opening and job chamber */}
        <path d={`M ${JOB.x - 18} 0 C ${JOB.x - 14} 40, ${JOB.x + 14} 40, ${JOB.x + 18} 0`} fill="none" stroke="#3B2414" strokeWidth="30" strokeLinecap="round" />
        <path d={`M ${JOB.x} 0 L ${JOB.x} ${JOB.y - 40}`} stroke="#3B2414" strokeWidth="26" strokeLinecap="round" />

        {/* tunnels */}
        {shown.map((a, i) => spots[i] && (
          <g key={`t-${a.handle}`}>
            <path d={tunnel(spots[i])} fill="none" stroke="#2E1C10" strokeWidth="34" strokeLinecap="round" />
            <path d={tunnel(spots[i])} fill="none" stroke={a.alive ? '#563620' : '#7E6448'} strokeWidth="25" strokeLinecap="round" />
            <path ref={(el) => (pathRefs.current[a.handle] = el)} d={tunnel(spots[i])} fill="none" stroke="none" />
          </g>
        ))}

        <ellipse cx={JOB.x} cy={JOB.y + 6} rx="138" ry="58" fill="#2E1C10" />
        <ellipse cx={JOB.x} cy={JOB.y + 6} rx="130" ry="51" fill="url(#chamberShade)" />
        <text x={JOB.x} y={JOB.y - 18} textAnchor="middle" className="farm-job-label">
          {open ? (open.reviewable || left === 0 ? 'Judging the answers' : `Open job · ${Math.ceil(left / 1000)}s left`) : lastPaid ? `${lastPaid.verdict.winner} won the last job` : 'Waiting for a job'}
        </text>
        {title && <text x={JOB.x} y={JOB.y + 46} textAnchor="middle" className="farm-job-title">{title}</text>}

        {/* chambers */}
        {shown.map((a, i) => {
          const c = spots[i];
          if (!c) return null;
          const runway = Number(BigInt(a.budget) / fee);
          const seeds = a.alive ? Math.min(10, runway) : 0;
          const starving = a.alive && !a.can_work;
          return (
            <g key={a.handle} className={`chamber ${a.alive ? '' : 'fossil'} ${starving ? 'starving' : ''}`} onClick={() => onPick?.(a.handle)} role="button" tabIndex={0} aria-label={`${a.name}: ${a.alive ? (starving ? 'starving' : 'foraging') : 'starved'}, ${runway} answers of food`} onKeyDown={(e) => e.key === 'Enter' && onPick?.(a.handle)}>
              <ellipse cx={c.x} cy={c.y + 2} rx="80" ry="40" fill="#2E1C10" />
              <ellipse cx={c.x} cy={c.y + 2} rx="73" ry="34" fill={a.alive ? 'url(#chamberShade)' : '#A08A6C'} className="chamber-floor" />
              {Array.from({ length: seeds }).map((_, k) => (
                <ellipse key={k} cx={c.x - 46 + k * 10.2} cy={c.y + 24 - (k % 2) * 3} rx="4.6" ry="3.1" transform={`rotate(${(k * 37) % 60 - 30} ${c.x - 46 + k * 10.2} ${c.y + 24})`} fill="#F2C14E" stroke="#B5862A" strokeWidth="0.8" />
              ))}
              <text x={c.x} y={c.y + 66} textAnchor="middle" className="farm-name">{a.name}</text>
              <text x={c.x} y={c.y + 84} textAnchor="middle" className="farm-meta">
                {a.alive ? `${(Number(BigInt(a.spot_price)) / 1e24).toFixed(3)} N/share · ${runway} meals` : 'starved'}
              </text>
            </g>
          );
        })}

        {/* ants */}
        {shown.map((a) => (
          <g key={`a-${a.handle}`} ref={(el) => (antRefs.current[a.handle] = el)} className={`ant ${a.alive ? '' : 'dead'}`} style={{ color: a.alive ? '#1A0F07' : '#8C7A62' }}>
            <AntShape />
            <ellipse className="carry" cx="15" cy="0" rx="3.6" ry="2.6" fill="#F2C14E" stroke="#B5862A" strokeWidth="0.6" style={{ opacity: 0 }} />
          </g>
        ))}
      </svg>
    </figure>
  );
}
