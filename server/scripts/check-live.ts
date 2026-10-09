/**
 * Live smoke test. Run before switching a server to SOURCE=live:
 *   RPC_HTTP=https://... npx tsx scripts/check-live.ts
 *
 * It checks every on-chain assumption Sift makes against Robinhood Chain:
 * - the Pons factory emits TokenLaunched with the expected layout
 * - a curve answers getReserves / sellableTokens / feeBps / creatorTaxBps / graduated
 * - getTokenInfo() decodes (socials)
 * - all launched curves share one runtime code hash (needed for the vault allowlist)
 * - a graduated token's v4 pool answers StateView and the V4Quoter
 */
import { createPublicClient, http, keccak256, type Address } from 'viem';
import { factoryAbi, ponsTokenInfoAbi, stateViewAbi } from '../src/chain/abis.js';
import { ADDR, robinhood } from '../src/chain/robinhood.js';
import { config } from '../src/config.js';
import { LiveSource, poolId } from '../src/sources/live.js';

const c = createPublicClient({ chain: robinhood, transport: http(config.rpcHttp) });
const ok = (m: string) => console.log('  ✓', m);
const bad = (m: string) => console.log('  ✗', m);

const latest = await c.getBlockNumber();
console.log(`Chain ${await c.getChainId()} at block ${latest}`);

const logs = [];
for (let to = latest; logs.length < 8 && to > latest - 2_000_000n; to -= 50_000n) {
  logs.push(...(await c.getLogs({ address: ADDR.ponsFactory, event: factoryAbi[0], fromBlock: to - 49_999n, toBlock: to })));
}
if (!logs.length) {
  bad('No TokenLaunched events found from the Pons factory. Check ADDR.ponsFactory.');
  process.exit(1);
}
ok(`${logs.length} recent launches decoded`);

const src = new LiveSource();
const hashes = new Set<string>();
let graduated: Address | null = null;
for (const l of logs.slice(0, 8)) {
  const { token, curve } = l.args as { token: Address; curve: Address };
  try {
    const st = await src.curveState(curve);
    ok(`curve ${curve.slice(0, 10)} reserves ${st.quoteReserve}/${st.tokenReserve}, fee ${st.feeBps}bps, tax ${st.creatorTaxBps}bps, graduated ${st.graduated}`);
    if (st.graduated && !graduated) graduated = token;
  } catch (e) {
    bad(`curve reads failed for ${curve}: ${(e as Error).message.split('\n')[0]}`);
  }
  const code = await c.getCode({ address: curve });
  if (code) hashes.add(keccak256(code));
  try {
    const info = await c.readContract({ address: token, abi: ponsTokenInfoAbi, functionName: 'getTokenInfo' });
    ok(`getTokenInfo ok for ${token.slice(0, 10)} (socials: ${JSON.stringify((info as readonly unknown[])[3])})`);
  } catch {
    bad(`getTokenInfo() did not decode for ${token}. Socials will be empty; update ponsTokenInfoAbi.`);
  }
}
if (hashes.size === 1) ok(`all curves share code hash ${[...hashes][0]}  → allowlist it on the vault factory`);
else bad(`curves have ${hashes.size} different code hashes. Allowlist each, or disable curve trading in vaults.`);

if (graduated) {
  const id = poolId(graduated);
  try {
    const s0 = await c.readContract({ address: ADDR.stateView, abi: stateViewAbi, functionName: 'getSlot0', args: [id] });
    ok(`v4 pool ${id.slice(0, 12)} slot0 ${s0[0]}`);
    const q = await src.quotePoolSell(graduated, 10n ** 18n * 1000n);
    ok(`V4Quoter sell 1000 tokens → ${q} wei`);
  } catch (e) {
    bad(`v4 pool reads failed: ${(e as Error).message.split('\n')[0]}. Check fee/tickSpacing/hook in PONS.`);
  }
} else console.log('  · no graduated token in the sample; v4 path not checked');
process.exit(0);
