import type { MarketSource, SourceHandlers } from './types.js';
import type { Address, CurveState, PoolState } from '../types.js';
import { PONS } from '../chain/robinhood.js';
import { curveBuyOut, curveSellOut } from '../trading/quote.js';

/**
 * A self-contained Pons-like market so the whole product runs without an RPC.
 * Launches, curve trades, transfers, graduation and pool trades follow the same
 * maths and events as the live chain. Time runs `speed`× faster than the wall clock.
 */

const E18 = 10n ** 18n;
const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const ri = (a: number, b: number) => Math.floor(rnd(a, b + 1));
const pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];
const addr = (): Address => ('0x' + [...Array(40)].map(() => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('')) as Address;
const TICK_MS = 150;
const SYL = ['ro', 'bin', 'hood', 'pep', 'moo', 'zap', 'kai', 'nova', 'fro', 'gli', 'dog', 'luna', 'vex', 'tur', 'bo', 'sky', 'rex', 'pix', 'yum', 'gob', 'wen', 'chad', 'mog', 'fren', 'ape'];

interface SimToken {
  token: Address;
  curve: Address;
  deployer: Address;
  q: number; // hidden quality 0..1
  rugger: boolean;
  born: number;
  c: CurveState;
  pool?: { eth: bigint; tok: bigint };
  bal: Map<Address, bigint>;
  wallets: Address[];
  rugAt: number;
  dead: boolean;
}

export class DemoSource implements MarketSource {
  readonly kind = 'demo' as const;
  private h!: SourceHandlers;
  private t0 = Date.now();
  private sim: SimToken[] = [];
  private byCurve = new Map<string, SimToken>();
  private byToken = new Map<string, SimToken>();
  private funders = new Map<string, Address>();
  private freshSet = new Set<string>();
  private timers: NodeJS.Timeout[] = [];
  private block = 1_000_000n;
  private ruggers: Address[] = [addr(), addr(), addr()];

  /** @param simLaunchEverySec simulated seconds between launches */
  constructor(private speed = 10, private simLaunchEverySec = 40) {}

  now() {
    return this.t0 + (Date.now() - this.t0) * this.speed;
  }
  ethUsd() {
    return 3000;
  }

  async start(h: SourceHandlers) {
    this.h = h;
    for (let i = 0; i < 6; i++) this.launch();
    this.timers.push(setInterval(() => this.launch(), Math.max(60, (this.simLaunchEverySec * 1000) / this.speed)));
    this.timers.push(setInterval(() => this.trade(), TICK_MS));
  }

  stop() {
    this.timers.forEach(clearInterval);
  }

  private launch() {
    const nm = pick(SYL) + pick(SYL) + (Math.random() < 0.3 ? pick(SYL) : '');
    const rugger = Math.random() < 0.18;
    const deployer = rugger ? pick(this.ruggers) : addr();
    const t: SimToken = {
      token: addr(),
      curve: addr(),
      deployer,
      q: Math.random(),
      rugger,
      born: this.now(),
      c: {
        quoteReserve: (15n * E18) / 10n, // phantom 1.5 ETH
        tokenReserve: PONS.supply,
        realQuoteReserve: 0n,
        sellable: PONS.curveSupply,
        threshold: (42n * E18) / 10n,
        feeBps: 100,
        creatorTaxBps: Math.random() < 0.85 ? 0 : ri(1, 10) * 100,
        graduated: false,
      },
      bal: new Map(),
      wallets: [],
      rugAt: this.now() + rnd(3, 25) * 60_000,
      dead: false,
    };
    this.sim.push(t);
    this.byCurve.set(t.curve, t);
    this.byToken.set(t.token, t);
    if (this.sim.length > 250) {
      const old = this.sim.shift()!;
      this.byCurve.delete(old.curve);
      this.byToken.delete(old.token);
    }
    const good = t.q > 0.62;
    this.h.onLaunch({
      token: t.token,
      curve: t.curve,
      deployer,
      pairToken: '0x0000000000000000000000000000000000000000',
      threshold: t.c.threshold,
      block: this.block++,
      time: t.born,
      name: nm[0].toUpperCase() + nm.slice(1),
      symbol: nm.slice(0, 5).toUpperCase(),
      socials: {
        twitter: Math.random() < (good ? 0.92 : 0.5) ? `https://x.com/${nm}` : undefined,
        telegram: Math.random() < (good ? 0.8 : 0.45) ? `https://t.me/${nm}` : undefined,
      },
    });
    // deployer buys a bag
    this.buy(t, deployer, BigInt(Math.round((rugger ? rnd(0.2, 0.6) : t.q > 0.5 ? rnd(0.005, 0.06) : rnd(0.02, 0.3)) * 1e6)) * 10n ** 12n);
    // bundlers: several wallets funded by one source buy in the first seconds
    if (!good && Math.random() < 0.45) {
      const funder = Math.random() < 0.5 ? deployer : addr();
      for (let i = 0; i < ri(3, 7); i++) {
        const w = addr();
        this.funders.set(w, funder);
        this.freshSet.add(w);
        this.buy(t, w, BigInt(Math.round(rnd(0.05, 0.25) * 1e6)) * 10n ** 12n);
      }
    }
    // snipers
    for (let i = 0; i < (good ? ri(0, 6) : ri(2, 22)); i++) this.buy(t, this.wallet(t, good), BigInt(Math.round(rnd(0.01, 0.08) * 1e6)) * 10n ** 12n);
  }

  private wallet(t: SimToken, good: boolean): Address {
    if (t.wallets.length > 5 && Math.random() < 0.2) return pick(t.wallets);
    const w = addr();
    this.funders.set(w, addr());
    if (Math.random() < (good ? 0.15 : 0.45)) this.freshSet.add(w);
    t.wallets.push(w);
    return w;
  }

  private trade() {
    const now = this.now();
    for (const t of this.sim) {
      if (t.dead) continue;
      const ageMin = (now - t.born) / 60_000;
      // rug: deployer dumps everything
      if (t.rugger && now > t.rugAt) {
        const b = t.bal.get(t.deployer) ?? 0n;
        if (b > 0n) this.sell(t, t.deployer, b);
        t.dead = Math.random() < 0.5;
        continue;
      }
      // trades per simulated minute: busy when young, fading with age; good tokens stay busy longer
      const life = Math.exp(-ageMin / (6 + t.q * 90));
      const perMin = 2 + 70 * life * (0.4 + t.q);
      const lambda = (perMin * TICK_MS * this.speed) / 60_000;
      const n = Math.floor(lambda) + (Math.random() < lambda % 1 ? 1 : 0);
      const buyBias = 0.36 + t.q * 0.3 + (t.q > 0.62 ? 0.06 : 0) - (ageMin > 30 ? 0.08 : 0);
      for (let i = 0; i < n; i++) {
        if (Math.random() < buyBias) {
          this.buy(t, this.wallet(t, t.q > 0.62), BigInt(Math.round(rnd(0.004, 0.05 + t.q * 0.12) * 1e6)) * 10n ** 12n);
        } else {
          const holders = [...t.bal.entries()].filter(([a, b]) => b > 0n && a !== t.deployer);
          if (!holders.length) continue;
          const [w, b] = pick(holders);
          this.sell(t, w, (b * BigInt(ri(15, 70))) / 100n);
        }
      }
      if (ageMin > 240 && t.q < 0.5) t.dead = true;
    }
  }

  private transfer(t: SimToken, from: Address, to: Address, amount: bigint) {
    if (from !== t.curve && from !== '0x0000000000000000000000000000000000000000') t.bal.set(from, (t.bal.get(from) ?? 0n) - amount);
    if (to !== t.curve) t.bal.set(to, (t.bal.get(to) ?? 0n) + amount);
    this.h.onTransfer({ token: t.token, from, to, amount, block: this.block, time: this.now() });
  }

  private buy(t: SimToken, w: Address, eth: bigint) {
    this.block++;
    if (!t.c.graduated) {
      const out = curveBuyOut(t.c, eth);
      if (out <= 0n) return;
      const net = eth - (eth * BigInt(t.c.feeBps + t.c.creatorTaxBps)) / 10_000n;
      t.c.quoteReserve += net;
      t.c.tokenReserve -= out;
      t.c.realQuoteReserve += net;
      t.c.sellable -= out;
      this.transfer(t, t.curve, w, out);
      this.h.onTrade({ token: t.token, venue: 'curve', side: 'buy', trader: w, eth, tokens: out, block: this.block, time: this.now(), tx: '0x' as `0x${string}` });
      if (t.c.realQuoteReserve >= t.c.threshold || t.c.sellable <= 0n) this.graduate(t);
    } else if (t.pool) {
      const net = (eth * 99n) / 100n;
      const out = (net * t.pool.tok) / (t.pool.eth + net);
      t.pool.eth += net;
      t.pool.tok -= out;
      this.transfer(t, t.curve, w, out);
      this.h.onTrade({ token: t.token, venue: 'pool', side: 'buy', trader: w, eth, tokens: out, block: this.block, time: this.now(), tx: '0x' as `0x${string}` });
    }
  }

  private sell(t: SimToken, w: Address, amount: bigint) {
    if (amount <= 0n) return;
    this.block++;
    if (!t.c.graduated) {
      const out = curveSellOut(t.c, amount);
      const gross = (amount * t.c.quoteReserve) / (t.c.tokenReserve + amount);
      t.c.quoteReserve -= gross;
      t.c.tokenReserve += amount;
      t.c.realQuoteReserve -= gross < t.c.realQuoteReserve ? gross : t.c.realQuoteReserve;
      t.c.sellable += amount;
      this.transfer(t, w, t.curve, amount);
      this.h.onTrade({ token: t.token, venue: 'curve', side: 'sell', trader: w, eth: out, tokens: amount, block: this.block, time: this.now(), tx: '0x' as `0x${string}` });
    } else if (t.pool) {
      const gross = (amount * t.pool.eth) / (t.pool.tok + amount);
      t.pool.eth -= gross;
      t.pool.tok += amount;
      this.transfer(t, w, t.curve, amount);
      this.h.onTrade({ token: t.token, venue: 'pool', side: 'sell', trader: w, eth: (gross * 99n) / 100n, tokens: amount, block: this.block, time: this.now(), tx: '0x' as `0x${string}` });
    }
  }

  private graduate(t: SimToken) {
    t.c.graduated = true;
    t.pool = { eth: t.c.realQuoteReserve, tok: (PONS.supply * 10n) / 49n };
    this.h.onGraduated(t.token, this.now());
  }

  /* ---------- reads ---------- */

  async curveState(curve: Address): Promise<CurveState> {
    const t = this.byCurve.get(curve);
    if (!t) throw new Error('unknown curve');
    return { ...t.c };
  }

  async poolState(token: Address): Promise<PoolState | null> {
    const t = this.byToken.get(token);
    if (!t?.pool) return null;
    const tokensPerEth = Number(t.pool.tok) / Number(t.pool.eth);
    const sqrtP = BigInt(Math.floor(Math.sqrt(tokensPerEth) * 2 ** 48)) * 2n ** 48n;
    const liquidity = BigInt(Math.floor(Math.sqrt(Number(t.pool.tok) * Number(t.pool.eth))));
    return { sqrtPriceX96: sqrtP, liquidity };
  }

  async quotePoolBuy(token: Address, ethIn: bigint) {
    const t = this.byToken.get(token);
    if (!t?.pool) return 0n;
    const net = (ethIn * 99n) / 100n;
    return (net * t.pool.tok) / (t.pool.eth + net);
  }

  async quotePoolSell(token: Address, tokensIn: bigint) {
    const t = this.byToken.get(token);
    if (!t?.pool) return 0n;
    return (((tokensIn * t.pool.eth) / (t.pool.tok + tokensIn)) * 99n) / 100n;
  }

  async funderOf(w: Address) {
    return this.funders.get(w) ?? null;
  }
  async isFresh(w: Address) {
    return this.freshSet.has(w);
  }
  async xFollowers() {
    return Math.random() < 0.5 ? ri(200, 5000) : ri(0, 900);
  }
}
