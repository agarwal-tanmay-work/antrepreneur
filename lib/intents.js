// NEAR Intents 1Click API: let a poster fund a job from any chain/token.
// Dry quotes (dry: true) need no funds and no JWT, so judges can try them.
// Docs: https://docs.near-intents.org/integration/distribution-channels/1click-api/quickstart
const API = process.env.ONECLICK_API || 'https://1click.chaindefuser.com';
const JWT = () => process.env.ONECLICK_JWT; // optional; without it 1Click adds a small fee

export const ORIGINS = {
  'usdc-base': { assetId: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near', label: 'USDC on Base', decimals: 6, refund: '0x1111111111111111111111111111111111111111' },
  'usdc-eth': { assetId: 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near', label: 'USDC on Ethereum', decimals: 6, refund: '0x1111111111111111111111111111111111111111' },
  'usdc-arb': { assetId: 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near', label: 'USDC on Arbitrum', decimals: 6, refund: '0x1111111111111111111111111111111111111111' },
  'eth-eth': { assetId: 'nep141:eth.omft.near', label: 'ETH on Ethereum', decimals: 18, refund: '0x1111111111111111111111111111111111111111' },
  'usdc-near': { assetId: 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', label: 'USDC on NEAR', decimals: 6, refund: 'near' },
};
const WNEAR = 'nep141:wrap.near';

const toUnits = (x, d) => {
  const [i, f = ''] = String(x).split('.');
  return (BigInt(i || '0') * 10n ** BigInt(d) + BigInt((f + '0'.repeat(d)).slice(0, d) || '0')).toString();
};

/**
 * Quote: pay `amount` of `origin` on its own chain, receive NEAR at `recipient`
 * (the poster's NEAR account, which then calls post_job). dry=true never moves funds.
 */
export async function quoteFunding({ origin = 'usdc-base', amount = '5', recipient = process.env.ANT_MAINNET_RECIPIENT || 'near', refundTo, dry = true }) {
  const o = ORIGINS[origin];
  if (!o) throw new Error(`unknown origin ${origin}`);
  const body = {
    dry, swapType: 'EXACT_INPUT', slippageTolerance: 100,
    originAsset: o.assetId, depositType: 'ORIGIN_CHAIN',
    destinationAsset: WNEAR, amount: toUnits(amount, o.decimals),
    refundTo: refundTo || o.refund, refundType: 'ORIGIN_CHAIN',
    recipient, recipientType: 'DESTINATION_CHAIN',
    deadline: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
  };
  const headers = { 'content-type': 'application/json', ...(JWT() ? { Authorization: `Bearer ${JWT()}` } : {}) };
  const r = await fetch(`${API}/v0/quote`, { method: 'POST', headers, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(`1Click ${r.status}: ${j.message || JSON.stringify(j).slice(0, 200)}`);
  return {
    dry, origin: o.label, amountIn: j.quote.amountInFormatted, amountInUsd: j.quote.amountInUsd,
    nearOut: j.quote.amountOutFormatted, minNearOut: (Number(j.quote.minAmountOut) / 1e24).toString(),
    timeEstimateSec: j.quote.timeEstimate, depositAddress: j.quote.depositAddress || null,
    recipient, request: body,
  };
}

/** Status of a real (non-dry) swap by deposit address. */
export async function swapStatus(depositAddress) {
  const r = await fetch(`${API}/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`);
  return r.json();
}
