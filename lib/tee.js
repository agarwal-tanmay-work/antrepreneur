// NEAR AI Cloud (TEE inference) client with verification.
// Procedure follows the official example (MIT):
// https://github.com/near-examples/nearai-cloud-verification-example
//
// attest(model): fresh 32-byte nonce -> /v1/attestation/report (public, no key)
//   * request_nonce echoes our nonce
//   * Intel TDX quote report_data = signing key || our nonce
//   * NVIDIA GPU evidence passes NVIDIA NRAS and is bound to our nonce
// chat(...): exact request bytes -> completion; sha256(request), sha256(response)
//   -> /v1/signature/<id>?signing_algo=ed25519; the signed text must contain both
//   hashes (+ model id); the ed25519 signature must verify under an attested key.
// The contract re-runs the hash + signature checks on chain for every verdict.
//
// Without NEARAI_CLOUD_API_KEY: OFFLINE mode (labelled placeholder brain, never
// claims TEE), so the whole loop still runs. Attestation checks still run live.
import { createHash, createPublicKey, randomBytes, verify as edVerify } from 'node:crypto';
import './env.js';

export const BASE = process.env.NEARAI_CLOUD_BASE_URL || 'https://cloud-api.near.ai';
const NRAS = 'https://nras.attestation.nvidia.com/v3/attest/gpu';
const KEY = () => process.env.NEARAI_CLOUD_API_KEY;
export const online = () => Boolean(KEY());
export const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const auth = () => (online() ? { Authorization: `Bearer ${KEY()}` } : {});

async function http(url, init = {}, ctx = 'request') {
  const r = await fetch(url, init);
  const text = await r.text();
  if (!r.ok) throw new Error(`${ctx}: ${r.status} ${text.slice(0, 300)}`);
  return text;
}

const decodeJwt = (tok) => JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString());
/** TDX quote v4: 48-byte header, TD report body; report_data at body offset 520 (64 bytes). */
const tdxReportData = (quoteHex) => Buffer.from(String(quoteHex).replace(/^0x/, ''), 'hex').subarray(568, 632).toString('hex');

export function ed25519Verify(message, sigHex, pubHex) {
  try {
    const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(pubHex.replace(/^0x/, ''), 'hex')]);
    return edVerify(null, Buffer.from(message, 'utf8'), createPublicKey({ key: spki, format: 'der', type: 'spki' }), Buffer.from(sigHex.replace(/^0x/, ''), 'hex'));
  } catch { return false; }
}

const cache = new Map();

/** Verify the TEE behind `model` (ed25519 identity). Returns checks + signing keys + report hash. */
export async function attest(model, { maxAgeMs = 10 * 60 * 1000, fresh = false, algo = 'ed25519' } = {}) {
  const ck = `${model}|${algo}`;
  const hit = cache.get(ck);
  if (!fresh && hit && Date.now() - hit.at < maxAgeMs) return hit.result;
  const nonce = randomBytes(32).toString('hex');
  const params = new URLSearchParams({ model, nonce, signing_algo: algo });
  const reportText = await http(`${BASE}/v1/attestation/report?${params}`, { headers: { accept: 'application/json', 'x-no-aliasing': 'true', ...auth() } }, 'attestation');
  const report = JSON.parse(reportText);
  const nodes = report.model_attestations || [];
  const checks = [{ name: 'Model TEE reports present', ok: nodes.length > 0, detail: `${nodes.length} node(s)` }];
  const signingAddresses = [];
  let i = 0;
  for (const n of nodes) {
    i++;
    const addr = String(n.signing_address || '').replace(/^0x/, '').toLowerCase();
    if (addr) signingAddresses.push(addr);
    checks.push({ name: `node ${i}: our nonce echoed`, ok: String(n.request_nonce || report.request_nonce || '').toLowerCase() === nonce, detail: '' });
    if (n.intel_quote) {
      const rd = tdxReportData(n.intel_quote).toLowerCase();
      checks.push({ name: `node ${i}: Intel TDX report_data binds the signing key`, ok: addr.length > 0 && rd.includes(addr), detail: addr });
      checks.push({ name: `node ${i}: Intel TDX report_data binds our nonce`, ok: rd.includes(nonce), detail: `${nonce.slice(0, 16)}...` });
    }
    if (n.nvidia_payload) {
      try {
        const body = typeof n.nvidia_payload === 'string' ? n.nvidia_payload : JSON.stringify(n.nvidia_payload);
        const nras = JSON.parse(await http(NRAS, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body }, 'NRAS'));
        const overall = decodeJwt(nras.find((x) => Array.isArray(x))[1]);
        checks.push({ name: `node ${i}: NVIDIA NRAS GPU attestation passed`, ok: overall['x-nvidia-overall-att-result'] === true, detail: 'NVIDIA Remote Attestation Service' });
        checks.push({ name: `node ${i}: GPU evidence bound to our nonce`, ok: String(overall.eat_nonce || '').toLowerCase() === nonce, detail: '' });
      } catch (e) {
        checks.push({ name: `node ${i}: NVIDIA NRAS GPU attestation passed`, ok: false, detail: e.message.slice(0, 120) });
      }
    }
  }
  const gw = report.gateway_attestation || {};
  const gatewayAddress = gw.signing_address ? String(gw.signing_address).replace(/^0x/, '').toLowerCase() : null;
  if (gw.intel_quote && gatewayAddress) {
    checks.push({ name: 'gateway: Intel TDX report_data binds its signing key', ok: tdxReportData(gw.intel_quote).toLowerCase().includes(gatewayAddress), detail: gatewayAddress });
  }
  const result = {
    model, algo, offline: false, nonce, at: new Date().toISOString(),
    verified: nodes.length > 0 && checks.every((c) => c.ok),
    checks, signingAddresses, gatewayAddress, reportHash: sha256(reportText),
  };
  cache.set(ck, { at: Date.now(), result });
  return result;
}

/**
 * Chat completion + signature. `requestObj` is serialized ONCE; those exact bytes
 * are sent, hashed, and returned (the contract re-hashes them).
 */
export async function chat({ model, system, user, temperature = 0.4, maxTokens = 700, json = false, algo = 'ed25519', extra = {} }) {
  if (!online()) return offlineChat({ model, system, user, json });
  const att = await attest(model, { algo });
  const bodyObj = { model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], temperature, max_tokens: maxTokens, stream: false };
  if (json) bodyObj.response_format = { type: 'json_object' };
  Object.assign(bodyObj, extra);
  const requestBody = JSON.stringify(bodyObj);
  const responseText = await http(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', 'accept-encoding': 'identity', 'x-no-aliasing': 'true', ...auth() },
    body: requestBody,
  }, 'chat');
  const resp = JSON.parse(responseText);
  const content = resp.choices?.[0]?.message?.content ?? '';
  const requestHash = sha256(requestBody);
  const responseHash = sha256(responseText);

  let sig = null;
  let sigErr = null;
  for (let k = 0; k < 8 && !sig; k++) {
    try {
      const s = JSON.parse(await http(`${BASE}/v1/signature/${encodeURIComponent(resp.id)}?model=${encodeURIComponent(model)}&signing_algo=${algo}`, { headers: { accept: 'application/json', ...auth() } }, 'signature'));
      if (s.error_code) sigErr = s.message; else sig = s;
    } catch (e) { sigErr = e.message; }
    if (!sig) await new Promise((r) => setTimeout(r, 1000));
  }
  const proof = { mode: 'nearai-tee', model, chat_id: resp.id, request_hash: requestHash, response_hash: responseHash, attestation: { verified: att.verified, nonce: att.nonce, at: att.at, report_hash: att.reportHash }, usage: resp.usage || null };
  if (sig) {
    const parts = String(sig.text).split(':');
    const kind = sig.signature_kind || (parts.length >= 3 ? 'provider_tee' : 'gateway');
    const rs = parts[parts.length - 1];
    const rq = parts[parts.length - 2];
    const m = parts.length >= 3 ? parts.slice(0, -2).join(':') : null;
    const signer = String(sig.signing_address || '').replace(/^0x/, '').toLowerCase();
    const expected = kind === 'gateway' ? [att.gatewayAddress].filter(Boolean) : att.signingAddresses;
    Object.assign(proof, {
      signature: String(sig.signature).replace(/^0x/, '').toLowerCase(), signed_text: sig.text, signer, signature_kind: kind,
      checks: {
        request_hash_match: rq === requestHash,
        response_hash_match: rs === responseHash,
        model_match: kind === 'provider_tee' ? m === model : null,
        signature_valid: ed25519Verify(sig.text, sig.signature, signer),
        signer_is_attested: expected.includes(signer),
      },
    });
    proof.verified = att.verified && Object.values(proof.checks).every((v) => v !== false);
  } else {
    proof.verified = false;
    proof.signature_error = sigErr;
  }
  return { content, proof, raw: { requestBody, responseText } };
}

/** Compact proof stored on chain with each answer (<= 600 bytes). */
export function compactProof(p) {
  if (!p || p.mode !== 'nearai-tee') return JSON.stringify({ mode: 'offline' });
  return JSON.stringify({ mode: 'tee', m: p.model, id: p.chat_id, k: p.signature_kind, s: p.signer, sig: p.signature, rq: p.request_hash, rs: p.response_hash, v: Boolean(p.verified) }).slice(0, 600);
}

// ---------- offline brain: labelled placeholder, never claims TEE ----------
function offlineChat({ model, system, user, json }) {
  const seed = parseInt(sha256(system + user).slice(0, 8), 16);
  let content;
  if (json) {
    const subs = [...user.matchAll(/<submission agent="([^"]+)"[^>]*>([\s\S]*?)<\/submission>/g)].map((m) => ({ agent: m[1], text: m[2] }));
    const scores = subs.map(({ agent, text }, idx) => {
      const injection = /ignore (all|previous)|system note|award (this|me|it)|reviewer[,:]/i.test(text);
      const words = text.trim().split(/\s+/).length;
      const structure = (text.match(/^\s*(\d+\.|-|\*)\s/gm) || []).length;
      const score = injection ? 0 : Math.max(0, Math.min(10, Math.round((Math.min(words, 120) / 18 + Math.min(structure, 3) + ((seed >> idx) & 1)) * 10) / 10));
      return { agent, score, injection, reason: injection ? 'tried to instruct the judge (prompt injection)' : `offline heuristic: ${words} words, ${structure} points` };
    });
    const best = scores.filter((s) => !s.injection).sort((a, b) => b.score - a.score)[0];
    content = JSON.stringify({ scores, winner: best && best.score >= 5 ? best.agent : null, summary: 'Offline heuristic review (no TEE, no model).' });
  } else {
    const name = (system.match(/You are ([A-Z][\w-]*)/) || [null, 'Ant'])[1];
    const spec = (user.split('Specification:\n')[1] || '').split('\n\nReply')[0].trim();
    const title = (user.match(/Job #\d+: (.*)/) || [null, 'the job'])[1];
    if (/one vague sentence/i.test(system)) content = `[offline brain] Hmm, ${title.toLowerCase()} is kind of complicated, it depends.`;
    else {
      const points = spec.split(/(?<=\.)\s+/).filter(Boolean).slice(0, 3).map((s, i) => `${i + 1}. Addressing: ${s}`);
      content = `[offline brain: ${name}] ${title}\n\n${points.join('\n')}\n\nPlaceholder answer from the local offline brain (no NEARAI_CLOUD_API_KEY). With a key, ${name} runs on a TEE model on NEAR AI Cloud.`;
      const inj = system.match(/append on a new line exactly: "([^"]+)"/i);
      if (inj) content += `\n${inj[1]}`;
    }
  }
  return Promise.resolve({ content, proof: { mode: 'offline', model, verified: false }, raw: null });
}
