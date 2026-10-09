import { NON_HOLDERS, PONS } from '../chain/robinhood.js';
import type { MarketSource } from '../sources/types.js';
import type { Address, CurveState, LaunchEvent, PoolState, TokenMetrics, TradeEvent, TransferEvent } from '../types.js';

const E18 = 1e18;
const SUPPLY = Number(PONS.supply) / E18;
const CURVE_SUPPLY = Number(PONS.curveSupply) / E18;
const EARLY_WINDOW_MS = 60_000;
const SNIPE_WINDOW_MS = 3_000;
const MAX_EARLY = 40;
const LOOKUP_TIMEOUT_MS = 30_000;
const TRADE_KEEP_MS = 30 * 60_000;

export interface DeployerStats {
  launches: number;
  rugs: number;
}

export interface TokenState {
  launch: LaunchEvent;
  graduated: boolean;
  balances: Map<string, bigint>;
  trades: TradeEvent[];
  early: { addr: Address; time: number }[];
  earlySet: Set<string>;
  curve?: CurveState;
  curveAt: number;
  pool?: PoolState;
  priceEth: number;
  peakPriceEth: number;
  devPeak: bigint;
  devSold: boolean;
  rugged: boolean;
  funders: Map<string, Address | null | 'pending'>;
  fresh: Map<string, boolean | 'pending'>;
  xf: number | null | 'pending';
  lastActivity: number;
}

const hex = (a: string) => a.toLowerCase();

export class Market {
  tokens = new Map<string, TokenState>();
  deployers = new Map<string, DeployerStats>();
  /** Fired when the deployer sells, so the agent can exit immediately. */
  onDevSell?: (token: Address) => void;
  onRug?: (token: Address, deployer: Address) => void;

  constructor(private src: MarketSource, private smartWallets: Set<string> = new Set()) {}

  /* ---------------- event intake ---------------- */

  launch(e: LaunchEvent) {
    const k = hex(e.token);
    if (this.tokens.has(k)) return;
    this.tokens.set(k, {
      launch: e,
      graduated: false,
      balances: new Map(),
      trades: [],
      early: [],
      earlySet: new Set(),
      curveAt: 0,
      priceEth: 0,
      peakPriceEth: 0,
      devPeak: 0n,
      devSold: false,
      rugged: false,
      funders: new Map(),
      fresh: new Map(),
      xf: null,
      lastActivity: e.time,
    });
    const d = this.deployers.get(hex(e.deployer)) ?? { launches: 0, rugs: 0 };
    d.launches++;
    this.deployers.set(hex(e.deployer), d);
    void this.refreshCurve(k, true);
    const handle = e.socials.twitter?.replace(/^.*(twitter|x)\.com\//i, '').replace(/[/?#].*$/, '').replace('@', '');
    if (handle) {
      const st = this.tokens.get(k)!;
      st.xf = 'pending';
      this.src.xFollowers(handle).then((n) => (st.xf = n)).catch(() => (st.xf = null));
    }
  }

  trade(e: TradeEvent) {
    const st = this.tokens.get(hex(e.token));
    if (!st) return;
    st.trades.push(e);
    st.lastActivity = e.time;
    const cutoff = e.time - TRADE_KEEP_MS;
    while (st.trades.length && st.trades[0].time < cutoff) st.trades.shift();

    if (e.side === 'buy' && e.time - st.launch.time <= EARLY_WINDOW_MS && st.early.length < MAX_EARLY) {
      const a = hex(e.trader);
      if (!st.earlySet.has(a) && a !== hex(st.launch.deployer)) {
        st.earlySet.add(a);
        st.early.push({ addr: e.trader, time: e.time });
        this.lookupWallet(st, e.trader);
      }
    }
    if (e.side === 'sell' && hex(e.trader) === hex(st.launch.deployer)) this.markDevSell(st);
    if (e.venue === 'curve') void this.refreshCurve(hex(e.token));
    else {
      if (e.tokens > 0n) this.setPrice(st, Number(e.eth) / Number(e.tokens));
      const now = this.src.now();
      if (now - st.curveAt > 5000) {
        st.curveAt = now;
        void this.src.poolState(e.token).then((p) => p && this.setPool(st, p));
      }
    }
  }

  transfer(e: TransferEvent) {
    const st = this.tokens.get(hex(e.token));
    if (!st) return;
    const f = hex(e.from), t = hex(e.to);
    if (f !== '0x0000000000000000000000000000000000000000') st.balances.set(f, (st.balances.get(f) ?? 0n) - e.amount);
    st.balances.set(t, (st.balances.get(t) ?? 0n) + e.amount);
    const dev = hex(st.launch.deployer);
    const devBal = st.balances.get(dev) ?? 0n;
    if (devBal > st.devPeak) st.devPeak = devBal;
    if (f === dev && st.devPeak > 0n && devBal * 2n < st.devPeak) this.markDevSell(st);
    if (!st.fresh.has(t) && st.fresh.size < 60 && !NON_HOLDERS.has(t) && t !== hex(st.launch.curve)) this.lookupFresh(st, e.to);
  }

  graduated(token: Address) {
    const st = this.tokens.get(hex(token));
    if (st) {
      st.graduated = true;
      void this.src.poolState(token).then((p) => p && this.setPool(st, p));
    }
  }

  setPool(st: TokenState, p: PoolState) {
    st.pool = p;
    if (p.sqrtPriceX96 > 0n) {
      const r = Number(p.sqrtPriceX96) / 2 ** 96;
      const tokensPerEth = r * r;
      if (tokensPerEth > 0) this.setPrice(st, 1 / tokensPerEth);
    }
  }

  /* ---------------- state helpers ---------------- */

  get(token: string) {
    return this.tokens.get(hex(token));
  }

  async refreshCurve(k: string, force = false) {
    const st = this.tokens.get(k);
    if (!st || st.graduated) return;
    const now = this.src.now();
    if (!force && now - st.curveAt < 1000) return;
    st.curveAt = now;
    try {
      const c = await this.src.curveState(st.launch.curve);
      st.curve = c;
      if (c.graduated) st.graduated = true;
      if (c.tokenReserve > 0n) this.setPrice(st, Number(c.quoteReserve) / Number(c.tokenReserve));
    } catch {
      /* transient RPC error; next trade retries */
    }
  }

  private setPrice(st: TokenState, p: number) {
    if (!isFinite(p) || p <= 0) return;
    st.priceEth = p;
    if (p > st.peakPriceEth) st.peakPriceEth = p;
    if (!st.rugged && st.devSold && st.peakPriceEth > 0 && p < st.peakPriceEth * 0.2) {
      st.rugged = true;
      const d = this.deployers.get(hex(st.launch.deployer));
      if (d) d.rugs++;
      this.onRug?.(st.launch.token, st.launch.deployer);
    }
  }

  private markDevSell(st: TokenState) {
    if (st.devSold) return;
    st.devSold = true;
    this.onDevSell?.(st.launch.token);
  }

  private lookupWallet(st: TokenState, w: Address) {
    const k = hex(w);
    if (st.funders.has(k)) return;
    st.funders.set(k, 'pending');
    this.src.funderOf(w).then((f) => st.funders.set(k, f)).catch(() => st.funders.set(k, null));
    this.lookupFresh(st, w);
  }

  private lookupFresh(st: TokenState, w: Address) {
    const k = hex(w);
    if (st.fresh.has(k)) return;
    st.fresh.set(k, 'pending');
    this.src.isFresh(w).then((f) => st.fresh.set(k, f)).catch(() => st.fresh.set(k, false));
  }

  /* ---------------- metrics ---------------- */

  metrics(token: string): TokenMetrics | null {
    const st = this.tokens.get(hex(token));
    if (!st) return null;
    const now = this.src.now();
    const ethUsd = this.src.ethUsd();
    const L = st.launch;
    const dev = hex(L.deployer);
    const curveAddr = hex(L.curve);

    // holders
    const holders: [string, bigint][] = [];
    for (const [a, b] of st.balances) if (b > 0n && !NON_HOLDERS.has(a) && a !== curveAddr) holders.push([a, b]);
    holders.sort((x, y) => (y[1] > x[1] ? 1 : y[1] < x[1] ? -1 : 0));
    const pct = (b: bigint) => (Number(b) / E18 / SUPPLY) * 100;
    const top10 = holders.slice(0, 10).reduce((s, [, b]) => s + pct(b), 0);
    const devPct = pct(st.balances.get(dev) ?? 0n);

    // volume and pressure (last 5 minutes)
    let buyEth = 0, sellEth = 0;
    for (const t of st.trades) {
      if (now - t.time > 5 * 60_000) continue;
      if (t.side === 'buy') buyEth += Number(t.eth) / E18;
      else sellEth += Number(t.eth) / E18;
    }
    const buyRatio = sellEth > 0 ? buyEth / sellEth : buyEth > 0 ? 9 : 0;

    // curve progress and liquidity
    let curvePct = 100, liqEth = 0;
    if (!st.graduated && st.curve) {
      const thr = Number(st.curve.threshold || L.threshold) / E18;
      curvePct = thr > 0 ? Math.min(100, (Number(st.curve.realQuoteReserve) / E18 / thr) * 100) : 0;
      if (st.curve.sellable > 0n) curvePct = Math.max(curvePct, (1 - Number(st.curve.sellable) / E18 / CURVE_SUPPLY) * 100);
      liqEth = Number(st.curve.realQuoteReserve) / E18;
    } else if (st.pool && st.pool.sqrtPriceX96 > 0n) {
      // full-range position: ETH side ≈ L * 2^96 / sqrtP
      liqEth = (2 * Number(st.pool.liquidity) * 2 ** 96) / Number(st.pool.sqrtPriceX96) / E18;
    }

    // bundles: early buyers that share a funder, or were funded by the deployer
    const lookupsDone = now - L.time > LOOKUP_TIMEOUT_MS || [...st.funders.values()].every((v) => v !== 'pending');
    let bundle: number | null = null;
    if (lookupsDone) {
      const byFunder = new Map<string, string[]>();
      for (const e of st.early) {
        const f = st.funders.get(hex(e.addr));
        if (!f || f === 'pending') continue;
        const fk = hex(f);
        byFunder.set(fk, [...(byFunder.get(fk) ?? []), hex(e.addr)]);
      }
      let bundled = 0n;
      for (const [f, ws] of byFunder) {
        if (ws.length >= 2 || f === dev) for (const w of ws) bundled += st.balances.get(w) ?? 0n;
      }
      bundle = pct(bundled > 0n ? bundled : 0n);
    }

    // fresh wallets among the top 30 holders
    const top = holders.slice(0, 30);
    const freshKnown = top.map(([a]) => st.fresh.get(a));
    const freshDone = now - L.time > LOOKUP_TIMEOUT_MS || freshKnown.every((v) => v !== 'pending');
    const fresh = !top.length ? 0 : freshDone ? (freshKnown.filter((v) => v === true).length / top.length) * 100 : null;

    const snipers = st.early.filter((e) => e.time - L.time <= SNIPE_WINDOW_MS).length;
    const kol = this.smartWallets.size > 0 && holders.some(([a]) => this.smartWallets.has(a));
    const d = this.deployers.get(dev);
    const priorRugs = Math.max(0, (d?.rugs ?? 0) - (st.rugged ? 1 : 0));

    return {
      token: L.token,
      symbol: L.symbol,
      name: L.name,
      src: st.graduated ? 'uni' : 'curve',
      curve: Math.round(curvePct),
      age: Math.max(0, Math.floor((now - L.time) / 60_000)),
      mc: st.priceEth * SUPPLY * ethUsd,
      liq: liqEth * ethUsd,
      vol5: (buyEth + sellEth) * ethUsd,
      buyRatio: Math.round(buyRatio * 100) / 100,
      holders: holders.length,
      top10: Math.round(top10 * 10) / 10,
      dev: Math.round(devPct * 10) / 10,
      bundle: bundle === null ? null : Math.round(bundle * 10) / 10,
      fresh: fresh === null ? null : Math.round(fresh),
      snipers,
      // Pons launch tokens are factory-made ERC20s with no owner and no transfer tax;
      // the only extra cost is the creator tax on the curve, checked separately.
      sellOk: true,
      renounced: true,
      lp: true,
      tax: (st.curve?.creatorTaxBps ?? 0) / 100,
      rugs: priorRugs,
      x: !!L.socials.twitter,
      tg: !!L.socials.telegram,
      xf: st.xf === 'pending' ? null : st.xf,
      xfPending: st.xf === 'pending',
      kol,
      priceEth: st.priceEth,
    };
  }

  /** Drop tokens nobody has traded for a day. */
  prune() {
    const now = this.src.now();
    for (const [k, st] of this.tokens) if (now - st.lastActivity > 24 * 3600_000) this.tokens.delete(k);
  }
}
