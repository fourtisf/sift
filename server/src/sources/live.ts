import { createPublicClient, encodeAbiParameters, http, keccak256, type Log, type PublicClient } from 'viem';
import { curveAbi, erc20Abi, factoryAbi, poolManagerAbi, ponsTokenInfoAbi, stateViewAbi, v4QuoterAbi } from '../chain/abis.js';
import { ADDR, PONS, robinhood } from '../chain/robinhood.js';
import { config } from '../config.js';
import type { Address, CurveState, PoolState } from '../types.js';
import type { MarketSource, SourceHandlers } from './types.js';

const ZERO = '0x0000000000000000000000000000000000000000' as Address;
const lc = (a: string) => a.toLowerCase();

export function poolKey(token: Address) {
  return { currency0: ZERO, currency1: token, fee: PONS.graduatedFee, tickSpacing: PONS.graduatedTickSpacing, hooks: ADDR.ponsHook as Address };
}

export function poolId(token: Address): `0x${string}` {
  const k = poolKey(token);
  return keccak256(
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
      [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks],
    ),
  );
}

/**
 * Reads Robinhood Chain over HTTP JSON-RPC by polling getLogs. Works with any provider;
 * use a paid endpoint (Alchemy, QuickNode, Dwellir...) in production.
 */
export class LiveSource implements MarketSource {
  readonly kind = 'live' as const;
  private c: PublicClient;
  private h!: SourceHandlers;
  private last = 0n;
  private stopped = false;
  private curves = new Map<string, Address>(); // curve -> token
  private tokens = new Set<string>();
  private pools = new Map<string, Address>(); // poolId -> token
  private price = 3000;
  private anchor = { block: 0n, ts: 0, msPerBlock: 250 };

  constructor() {
    this.c = createPublicClient({ chain: robinhood, transport: http(config.rpcHttp, { batch: true, retryCount: 3 }) }) as PublicClient;
  }

  now() {
    return Date.now();
  }
  ethUsd() {
    return this.price;
  }

  private timeOf(block: bigint) {
    return this.anchor.ts - Number(this.anchor.block - block) * this.anchor.msPerBlock;
  }

  private async calibrate() {
    const latest = await this.c.getBlock();
    const back = await this.c.getBlock({ blockNumber: latest.number - 2000n });
    const span = Number(latest.timestamp - back.timestamp) * 1000;
    this.anchor = { block: latest.number, ts: Number(latest.timestamp) * 1000, msPerBlock: Math.max(20, span / 2000) };
  }

  async start(h: SourceHandlers) {
    this.h = h;
    await this.calibrate();
    void this.ethPriceLoop();
    const latest = this.anchor.block;
    const from = latest > config.backfillBlocks ? latest - config.backfillBlocks : 0n;
    console.log(`[live] backfilling blocks ${from}..${latest}`);
    await this.scan(from, latest);
    this.last = latest;
    void this.loop();
  }

  stop() {
    this.stopped = true;
  }

  private async ethPriceLoop() {
    while (!this.stopped) {
      try {
        const r = await fetch('https://api.coinbase.com/v2/prices/ETH-USD/spot');
        const j = (await r.json()) as { data?: { amount?: string } };
        const p = Number(j.data?.amount);
        if (p > 0) this.price = p;
      } catch {
        /* keep last price */
      }
      await new Promise((r) => setTimeout(r, 60_000));
    }
  }

  private async loop() {
    while (!this.stopped) {
      try {
        const latest = await this.c.getBlockNumber();
        if (latest > this.last) {
          const to = latest - this.last > 5000n ? this.last + 5000n : latest;
          this.anchor = { ...this.anchor, block: to, ts: Date.now() - Number(latest - to) * this.anchor.msPerBlock };
          await this.scan(this.last + 1n, to);
          this.last = to;
        }
      } catch (e) {
        console.error('[live] poll error', (e as Error).message);
      }
      await new Promise((r) => setTimeout(r, config.pollMs));
    }
  }

  /** Pull every relevant log in [from, to] in chunks and feed the handlers in block order. */
  private async scan(from: bigint, to: bigint) {
    const CHUNK = 10_000n;
    for (let a = from; a <= to; a += CHUNK) {
      const b = a + CHUNK - 1n > to ? to : a + CHUNK - 1n;

      const launches = await this.c.getLogs({ address: ADDR.ponsFactory, events: factoryAbi, fromBlock: a, toBlock: b });
      for (const l of launches) await this.onFactoryLog(l as never);

      const curveLogs = await this.c.getLogs({ events: curveAbi.filter((x) => x.type === 'event'), fromBlock: a, toBlock: b });
      const transfers = this.tokens.size
        ? (
            await Promise.all(
              chunk([...this.tokens], 200).map((addrs) =>
                this.c.getLogs({ address: addrs as Address[], event: erc20Abi[0], fromBlock: a, toBlock: b }),
              ),
            )
          ).flat()
        : [];
      const swaps = this.pools.size
        ? await this.c.getLogs({ address: ADDR.poolManager, event: poolManagerAbi[0], args: { id: [...this.pools.keys()] as `0x${string}`[] }, fromBlock: a, toBlock: b })
        : [];

      const all = [...curveLogs, ...transfers, ...swaps].sort((x, y) =>
        x.blockNumber === y.blockNumber ? (x.logIndex ?? 0) - (y.logIndex ?? 0) : Number((x.blockNumber ?? 0n) - (y.blockNumber ?? 0n)),
      );
      for (const l of all) this.onLog(l as never);
    }
  }

  private async onFactoryLog(l: Log & { eventName: string; args: Record<string, unknown> }) {
    const time = this.timeOf(l.blockNumber!);
    if (l.eventName === 'TokenLaunched') {
      const token = l.args.token as Address;
      const curve = l.args.curve as Address;
      this.curves.set(lc(curve), token);
      this.tokens.add(lc(token));
      const [name, symbol, info] = await Promise.all([
        this.c.readContract({ address: token, abi: erc20Abi, functionName: 'name' }).catch(() => '?'),
        this.c.readContract({ address: token, abi: erc20Abi, functionName: 'symbol' }).catch(() => '?'),
        this.c.readContract({ address: token, abi: ponsTokenInfoAbi, functionName: 'getTokenInfo' }).catch(() => null),
      ]);
      const so = (info as readonly unknown[] | null)?.[3] as { twitter?: string; telegram?: string; website?: string } | undefined;
      this.h.onLaunch({
        token,
        curve,
        deployer: l.args.deployer as Address,
        pairToken: l.args.pairToken as Address,
        threshold: l.args.graduationThreshold as bigint,
        block: l.blockNumber!,
        time,
        name: String(name),
        symbol: String(symbol),
        socials: { twitter: so?.twitter || undefined, telegram: so?.telegram || undefined, website: so?.website || undefined },
      });
    } else if (l.eventName === 'PoolGraduated') {
      const token = l.args.token as Address;
      this.pools.set(lc(poolId(token)), token);
      this.h.onGraduated(token, time);
    }
  }

  private onLog(l: Log & { eventName: string; args: Record<string, unknown> }) {
    const time = this.timeOf(l.blockNumber!);
    const block = l.blockNumber!;
    const tx = l.transactionHash!;
    if (l.eventName === 'CurveBuy' || l.eventName === 'CurveSell') {
      const token = this.curves.get(lc(l.address));
      if (!token) return;
      const buy = l.eventName === 'CurveBuy';
      this.h.onTrade({
        token,
        venue: 'curve',
        side: buy ? 'buy' : 'sell',
        trader: (buy ? l.args.recipient : l.args.seller) as Address,
        eth: (buy ? l.args.quoteIn : l.args.quoteOut) as bigint,
        tokens: (buy ? l.args.tokensOut : l.args.tokensIn) as bigint,
        block,
        time,
        tx,
      });
    } else if (l.eventName === 'Transfer') {
      this.h.onTransfer({ token: l.address as Address, from: l.args.from as Address, to: l.args.to as Address, amount: l.args.value as bigint, block, time });
    } else if (l.eventName === 'Swap') {
      const token = this.pools.get(lc(l.args.id as string));
      if (!token) return;
      const a0 = l.args.amount0 as bigint;
      const a1 = l.args.amount1 as bigint;
      // amounts are the swapper's deltas: negative = paid in
      const buy = a0 < 0n;
      this.h.onTrade({ token, venue: 'pool', side: buy ? 'buy' : 'sell', trader: l.args.sender as Address, eth: a0 < 0n ? -a0 : a0, tokens: a1 < 0n ? -a1 : a1, block, time, tx });
    }
  }

  /* ---------- reads ---------- */

  async curveState(curve: Address): Promise<CurveState> {
    const r = (fn: string) => this.c.readContract({ address: curve, abi: curveAbi, functionName: fn as never });
    const [res, real, sellable, thr, fee, tax, grad] = await Promise.all([
      r('getReserves'),
      r('realQuoteReserve'),
      r('sellableTokens'),
      r('graduationThreshold'),
      r('feeBps'),
      r('creatorTaxBps'),
      r('graduated'),
    ]);
    const [q, t] = res as readonly [bigint, bigint];
    return {
      quoteReserve: q,
      tokenReserve: t,
      realQuoteReserve: real as bigint,
      sellable: sellable as bigint,
      threshold: thr as bigint,
      feeBps: Number(fee),
      creatorTaxBps: Number(tax),
      graduated: grad as boolean,
    };
  }

  async poolState(token: Address): Promise<PoolState | null> {
    const id = poolId(token);
    this.pools.set(lc(id), token);
    try {
      const [slot0, liq] = await Promise.all([
        this.c.readContract({ address: ADDR.stateView, abi: stateViewAbi, functionName: 'getSlot0', args: [id] }),
        this.c.readContract({ address: ADDR.stateView, abi: stateViewAbi, functionName: 'getLiquidity', args: [id] }),
      ]);
      return { sqrtPriceX96: (slot0 as readonly bigint[])[0], liquidity: liq as bigint };
    } catch {
      return null;
    }
  }

  private async quote(token: Address, zeroForOne: boolean, amount: bigint) {
    const { result } = await this.c.simulateContract({
      address: ADDR.v4Quoter,
      abi: v4QuoterAbi,
      functionName: 'quoteExactInputSingle',
      args: [{ poolKey: poolKey(token), zeroForOne, exactAmount: amount, hookData: '0x' }],
    });
    return result[0];
  }
  quotePoolBuy(token: Address, ethIn: bigint) {
    return this.quote(token, true, ethIn);
  }
  quotePoolSell(token: Address, tokensIn: bigint) {
    return this.quote(token, false, tokensIn);
  }

  private funderCache = new Map<string, Address | null>();
  async funderOf(w: Address): Promise<Address | null> {
    const k = lc(w);
    if (this.funderCache.has(k)) return this.funderCache.get(k)!;
    let best: { ts: string; from: Address } | null = null;
    for (const path of ['transactions', 'internal-transactions']) {
      try {
        const r = await fetch(`${config.blockscoutApi}/addresses/${w}/${path}?filter=to`);
        if (!r.ok) continue;
        const j = (await r.json()) as { items?: { timestamp: string; value: string; from: { hash: string } }[] };
        for (const it of j.items ?? []) {
          if (BigInt(it.value || '0') === 0n) continue;
          if (!best || it.timestamp < best.ts) best = { ts: it.timestamp, from: it.from.hash as Address };
        }
      } catch {
        /* explorer down: treat as unknown */
      }
    }
    const f = best?.from ?? null;
    this.funderCache.set(k, f);
    return f;
  }

  async isFresh(w: Address) {
    const n = await this.c.getTransactionCount({ address: w });
    return n <= 3;
  }

  async xFollowers(handle: string) {
    if (!config.xBearer) return null;
    try {
      const r = await fetch(`https://api.twitter.com/2/users/by/username/${encodeURIComponent(handle)}?user.fields=public_metrics`, {
        headers: { authorization: `Bearer ${config.xBearer}` },
      });
      const j = (await r.json()) as { data?: { public_metrics?: { followers_count?: number } } };
      return j.data?.public_metrics?.followers_count ?? null;
    } catch {
      return null;
    }
  }
}

function chunk<T>(a: T[], n: number) {
  const out: T[][] = [];
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
  return out;
}
