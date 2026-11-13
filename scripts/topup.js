// Testnet only: create throwaway faucet accounts and send their NEAR to an account.
//   npm run topup -- poster.hl-ops-xxx.testnet 2      (2 faucet accounts = ~20 NEAR)
import { faucetCreate, account, toYocto } from '../lib/near.js';
const [to = process.env.ANT_POSTER, n = '1'] = process.argv.slice(2);
for (let i = 0; i < Number(n); i++) {
  const id = `hl-tmp-${Math.random().toString(36).slice(2, 9)}.testnet`;
  await faucetCreate(id);
  await new Promise((r) => setTimeout(r, 2500));
  const a = account(id);
  await a.transfer({ receiverId: to, amount: (await a.getBalance()) - toYocto(0.05) });
  console.log(`moved faucet NEAR from ${id} -> ${to}`);
}
