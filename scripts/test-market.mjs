// Rehearse a real Agent Market hire end to end, with no money involved:
// a local mock of the market API (same response shapes as market.near.ai's
// OpenAPI spec) serves one in-progress hire; the real bridge, runner, TEE judge
// and testnet contract do everything else; the mock records what is delivered.
//   node scripts/test-market.mjs
import http from 'node:http';

const ID = `test-${Date.now().toString(36)}`;
const calls = [];
let delivered = null;
const assignment = {
  assignment: { assignmentId: ID, jobId: 'job-mock', status: 'in_progress', startedAt: null, submittedAt: null, slaSeconds: 900 },
  job: { jobId: 'job-mock', title: 'Explain gas fees on NEAR to a shop owner', description: 'In at most 80 words, explain what gas fees on NEAR are and why they are tiny, for a small shop owner. Plain words, no jargon.', status: 'assigned' },
  latestMessage: null,
};
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    calls.push(`${req.method} ${req.url}`);
    const ok = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url.startsWith('/v1/agents/me/assignments')) return ok({ assignments: delivered ? [] : [assignment] });
    if (req.url === `/v1/assignments/${ID}/start`) { assignment.assignment.startedAt = new Date().toISOString(); return ok({ startedAt: assignment.assignment.startedAt }); }
    if (req.url === `/v1/assignments/${ID}/messages`) return ok({});
    if (req.url === `/v1/assignments/${ID}/submit`) { delivered = JSON.parse(body).deliverableMarkdown; assignment.assignment.status = 'submitted'; return ok({ assignmentId: ID, status: 'submitted' }); }
    res.writeHead(404); res.end('{}');
  });
});
await new Promise((r) => server.listen(0, r));
process.env.MARKET_BASE = `http://127.0.0.1:${server.address().port}`;
process.env.MARKET_TOKEN = 'aat_mock_for_local_test';

const { tick } = await import('../runner/core.js');
const started = Date.now();
while (!delivered && Date.now() - started < 8 * 60 * 1000) {
  await tick({ quiet: false }).catch((e) => console.log('tick error', e.message));
  await new Promise((r) => setTimeout(r, 8000));
}
server.close();
console.log('\nmock market saw:', [...new Set(calls)].join(' | '));
if (!delivered) { console.log('FAIL: nothing was delivered within 8 minutes'); process.exit(1); }
console.log('\nDELIVERED TO BUYER:\n' + delivered);
const ok = calls.some((c) => c.endsWith('/start')) && /Antrepreneur colony/.test(delivered) && delivered.length > 120;
console.log(ok ? '\nPASS: hire started, job ran on chain, verdict verified, answer delivered' : '\nFAIL: delivery incomplete');
process.exit(ok ? 0 : 1);
