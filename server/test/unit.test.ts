import { describe, expect, it } from 'vitest';
import { evaluate } from '../src/engine/rules.js';
import { heuristicScore, parseVerdict } from '../src/engine/ai.js';
import { curveBuyOut, curveSellOut, minOut } from '../src/trading/quote.js';
import { PRESETS } from '../src/strategy.js';
import { poolId } from '../src/sources/live.js';
import { Market } from '../src/market/market.js';
import type { MarketSource } from '../src/sources/types.js';
import type { Address, CurveState, TokenMetrics } from '../src/types.js';

const E18 = 10n ** 18n;

const base: TokenMetrics = {
  token: '0x0000000000000000000000000000000000000001',
  symbol: 'TEST',
  name: 'Test',
  src: 'curve',
  curve: 60,
  age: 10,
  mc: 50_000,
  liq: 9_000,
  vol5: 8_000,
  buyRatio: 1.8,
  holders: 250,
  top10: 18,
  dev: 2,
  bundle: 1,
  fresh: 10,
  snipers: 3,
  sellOk: true,
  renounced: true,
  lp: true,
  tax: 0,
  rugs: 0,
  x: true,
  tg: true,
  xf: 900,
  xfPending: false,
  kol: false,
  priceEth: 0.00001,
};

describe('rules', () => {
  it('passes a healthy token under the Balanced preset', () => {
    const r = evaluate(base, PRESETS.balanced);
    expect(r.firstFail).toBeNull();
    expect(r.pending).toEqual([]);
  });

  it('stops at the first failing layer, in order', () => {
    expect(evaluate({ ...base, age: 1 }, PRESETS.balanced).firstFail).toBe('src');
    expect(evaluate({ ...base, liq: 100 }, PRESETS.balanced).firstFail).toBe('mkt');
    expect(evaluate({ ...base, bundle: 40 }, PRESETS.balanced).firstFail).toBe('hold');
    expect(evaluate({ ...base, rugs: 2 }, PRESETS.balanced).firstFail).toBe('safe');
    expect(evaluate({ ...base, x: false, tg: false }, PRESETS.balanced).firstFail).toBe('soc');
  });

  it('waits instead of rejecting while lookups are pending', () => {
    const r = evaluate({ ...base, bundle: null, fresh: null }, PRESETS.balanced);
    expect(r.firstFail).toBeNull();
    expect(r.pending).toEqual(['bundles', 'fresh wallets']);
  });

  it('skips the follower check when no X data is available', () => {
    const r = evaluate({ ...base, xf: null }, PRESETS.balanced);
    expect(r.firstFail).toBeNull();
    expect(r.checks.some((c) => c.l.includes('followers'))).toBe(false);
  });

  it('only allows graduated tokens in the Careful preset', () => {
    expect(evaluate(base, PRESETS.safe).firstFail).toBe('src');
  });
});

describe('curve maths', () => {
  const c: CurveState = {
    quoteReserve: 15n * E18 / 10n,
    tokenReserve: 1_000_000_000n * E18,
    realQuoteReserve: 0n,
    sellable: 714_285_714n * E18,
    threshold: 42n * E18 / 10n,
    feeBps: 100,
    creatorTaxBps: 0,
    graduated: false,
  };

  it('charges the 1% fee before pricing a buy', () => {
    const out = curveBuyOut(c, E18 / 10n);
    const net = (E18 / 10n) * 99n / 100n;
    expect(out).toBe((net * c.tokenReserve) / (c.quoteReserve + net));
  });

  it('a round trip loses about the fees, not more', () => {
    const t = curveBuyOut(c, E18 / 10n);
    const after: CurveState = { ...c, quoteReserve: c.quoteReserve + (E18 / 10n) * 99n / 100n, tokenReserve: c.tokenReserve - t };
    const back = curveSellOut(after, t);
    const loss = Number(E18 / 10n - back) / 1e17;
    expect(loss).toBeGreaterThan(0.019);
    expect(loss).toBeLessThan(0.021);
  });

  it('never quotes more than the curve can sell', () => {
    expect(curveBuyOut({ ...c, sellable: 5n }, E18)).toBe(5n);
  });

  it('applies slippage', () => {
    expect(minOut(10_000n, 3)).toBe(9_700n);
  });
});

describe('ai', () => {
  it('parses a model reply wrapped in prose', () => {
    const v = parseVerdict('Sure: {"score": 81, "positives": ["a","b"], "concerns": ["c"], "summary": "ok"} thanks');
    expect(v).toMatchObject({ score: 81, pos: ['a', 'b'], neg: ['c'], source: 'model' });
  });
  it('heuristic penalises past rugs', () => {
    expect(heuristicScore({ ...base, rugs: 2 }).score).toBeLessThan(heuristicScore(base).score);
  });
});

describe('pons pool id', () => {
  it('is a 32-byte hash and stable per token', () => {
    const a = poolId('0x2861f208e71ced7beab010457bf10f0c1ccc0e2d');
    expect(a).toMatch(/^0x[0-9a-f]{64}$/);
    expect(poolId('0x2861f208e71ced7beab010457bf10f0c1ccc0e2d')).toBe(a);
  });
});

describe('market metrics', () => {
  const now = 1_700_000_000_000;
  const funders: Record<string, Address> = {};
  const fake: MarketSource = {
    kind: 'demo',
    start: async () => {},
    stop: () => {},
    now: () => now + 120_000,
    ethUsd: () => 3000,
    curveState: async () => ({ quoteReserve: 2n * E18, tokenReserve: 900_000_000n * E18, realQuoteReserve: E18, sellable: 600_000_000n * E18, threshold: 42n * E18 / 10n, feeBps: 100, creatorTaxBps: 200, graduated: false }),
    poolState: async () => null,
    quotePoolBuy: async () => 0n,
    quotePoolSell: async () => 0n,
    funderOf: async (w) => funders[w.toLowerCase()] ?? null,
    isFresh: async () => false,
    xFollowers: async () => 1234,
  };

  it('computes holders, top 10, bundles and tax', async () => {
    const m = new Market(fake);
    const token = '0x00000000000000000000000000000000000000aa' as Address;
    const curve = '0x00000000000000000000000000000000000000cc' as Address;
    const dev = '0x00000000000000000000000000000000000000dd' as Address;
    m.launch({ token, curve, deployer: dev, pairToken: '0x0000000000000000000000000000000000000000', threshold: 42n * E18 / 10n, block: 1n, time: now, name: 'A', symbol: 'A', socials: { twitter: 'https://x.com/a' } });
    const w1 = '0x0000000000000000000000000000000000000011' as Address;
    const w2 = '0x0000000000000000000000000000000000000012' as Address;
    const w3 = '0x0000000000000000000000000000000000000013' as Address;
    funders[w1] = funders[w2] = '0x00000000000000000000000000000000000000ff' as Address; // same funder → bundle
    funders[w3] = '0x00000000000000000000000000000000000000ee' as Address;
    for (const [w, amt] of [[w1, 20_000_000n], [w2, 10_000_000n], [w3, 5_000_000n]] as const) {
      m.trade({ token, venue: 'curve', side: 'buy', trader: w, eth: E18 / 10n, tokens: amt * E18, block: 2n, time: now + 1000, tx: '0x' });
      m.transfer({ token, from: curve, to: w, amount: amt * E18, block: 2n, time: now + 1000 });
    }
    await new Promise((r) => setTimeout(r, 10));
    const x = m.metrics(token)!;
    expect(x.holders).toBe(3);
    expect(x.top10).toBeCloseTo(3.5, 1);
    expect(x.bundle).toBeCloseTo(3.0, 1);
    expect(x.snipers).toBe(3);
    expect(x.tax).toBe(2);
    expect(x.xf).toBe(1234);
    expect(x.age).toBe(2);
  });

  it('flags a deployer sell and counts a rug', async () => {
    const m = new Market(fake);
    let devSold = false;
    m.onDevSell = () => (devSold = true);
    const token = '0x00000000000000000000000000000000000000ab' as Address;
    const curve = '0x00000000000000000000000000000000000000cd' as Address;
    const dev = '0x00000000000000000000000000000000000000de' as Address;
    m.launch({ token, curve, deployer: dev, pairToken: '0x0000000000000000000000000000000000000000', threshold: 1n, block: 1n, time: now, name: 'B', symbol: 'B', socials: {} });
    m.transfer({ token, from: curve, to: dev, amount: 100n * E18, block: 2n, time: now });
    m.transfer({ token, from: dev, to: curve, amount: 100n * E18, block: 3n, time: now });
    expect(devSold).toBe(true);
  });
});
