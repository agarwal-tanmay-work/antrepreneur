// Rehearse the webhook path end to end (no cron, no poller): a signed hire.created
// reaches the real server, which posts the on-chain job, drives the colony and
// delivers to a mock Agent Market.   node scripts/test-webhook.mjs
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { spawn } from 'node:child_process';

const ID = `wh-${Date.now().toString(36)}`, SECRET = 'whsec_rehearsal', PORT = 3911;
let delivered = null;
const asg = { assignment: { assignmentId: ID, status: 'in_progress', startedAt: new Date().toISOString() }, job: { title: 'What is a NEAR named account?', description: 'In under 70 words, explain what a NEAR named account (like alice.near) is to a new user.' } };
const mock = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
    const ok = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url.startsWith('/v1/agents/me/assignments')) return ok({ assignments: delivered ? [] : [asg] });
    if (req.url.endsWith('/submit')) { delivered = JSON.parse(b).deliverableMarkdown; return ok({ status: 'submitted' }); }
    return ok({});
  });
});
await new Promise((r) => mock.listen(0, r));
const srv = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(PORT), RUNNER: '0', MARKET_WEBHOOK_SECRET: SECRET, MARKET_TOKEN: 'aat_mock', MARKET_BASE: `http://127.0.0.1:${mock.address().port}` }, stdio: 'inherit' });
for (let i = 0; i < 30; i++) { try { await fetch(`http://127.0.0.1:${PORT}/api/attest`); break; } catch { await new Promise((r) => setTimeout(r, 1000)); } }
const body = JSON.stringify({ event: 'hire.created', assignment_id: ID, title: asg.job.title, description: asg.job.description });
const ts = String(Math.floor(Date.now() / 1000));
const r = await fetch(`http://127.0.0.1:${PORT}/api/market/webhook`, { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-market-event': 'hire.created', 'x-market-delivery': ID, 'x-market-timestamp': ts, 'x-market-signature': 'sha256=' + createHmac('sha256', SECRET).update(`${ts}.${body}`).digest('hex') } });
console.log('webhook ->', r.status, await r.text());
const t0 = Date.now();
while (!delivered && Date.now() - t0 < 9 * 60_000) await new Promise((r) => setTimeout(r, 3000));
srv.kill(); mock.close();
if (!delivered) { console.log('FAIL: not delivered in 9 minutes'); process.exit(1); }
console.log(`\nDELIVERED after ${Math.round((Date.now() - t0) / 1000)}s:\n${delivered}\n\nPASS`);
process.exit(0);
