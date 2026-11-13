// Deterministic ant keys: every ant's function-call key is derived from one
// secret seed (ANT_AGENT_SEED) and its handle, so a stateless server (Vercel)
// can operate any ant it spawned without storing key files.
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { KeyPairEd25519 } from 'near-api-js';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function base58(buf) {
  let n = BigInt('0x' + (Buffer.from(buf).toString('hex') || '0'));
  let out = '';
  while (n > 0n) { out = ALPHABET[Number(n % 58n)] + out; n /= 58n; }
  for (const b of buf) { if (b === 0) out = '1' + out; else break; }
  return out;
}

const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/** ed25519 key pair from a 32-byte seed. */
export function keyPairFromSeed(seed32) {
  const priv = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed32]), format: 'der', type: 'pkcs8' });
  const pub = createPublicKey(priv).export({ format: 'der', type: 'spki' }).subarray(-32);
  return new KeyPairEd25519(base58(Buffer.concat([seed32, pub])));
}

export function antKeyPair(handle, contractId = process.env.ANT_CONTRACT, seed = process.env.ANT_AGENT_SEED) {
  if (!seed) throw new Error('ANT_AGENT_SEED is not set');
  const s = createHash('sha256').update(`${seed}:${contractId}:${handle}`).digest();
  return keyPairFromSeed(s);
}
