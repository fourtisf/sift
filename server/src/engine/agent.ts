import { EventEmitter } from 'node:events';
import { aiScore } from './ai.js';
import { evaluate, HUMAN, PERMANENT } from './rules.js';
import type { Market } from '../market/market.js';
import type { MarketSource } from '../sources/types.js';
import type { Strategy, Layer } from '../strategy.js';
import { newId, type Mode, type PositionRow, type Store, type UserRow } from '../store/db.js';
import type { Executor, Venue } from '../trading/executor.js';
import { toEth, toWei } from '../trading/quote.js';
import type { Telegram } from '../notify/telegram.js';
import type { Address, AiVerdict, Check, DecisionDTO, TokenMetrics } from '../types.js';

const HUES = ['#C4B5FF', '#7CF0C5', '#FFB89A', '#8FD3FF', '#FFE38A', '#FF9FC0', '#9BE58B', '#FFC08A'];
export const hueOf = (a: string) => HUES[parseInt(a.slice(-4), 16) % HUES.length];
const clock = (ms: number) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const DAY = 86_400_000;

interface TokenStatus {
  ff: Layer | null;
  out: DecisionDTO['out'] | null;
  loggedAt: number;
  final: boolean;
}

export interface UserEvent {
  type: 'decision' | 'trade' | 'positions' | 'state';
  data: unknown;
}

export class Engine extends EventEmitter {
  private status = new Map<string, Map<string, TokenStatus>>();
  private busy = new Set<string>();
  private timer?: NodeJS.Timeout;
  private ticks = 0;
  private metricsCache = new Map<string, TokenMetrics | null>();
  private running = false;

  constructor(
    private src: MarketSource,
    private market: Market,
    private store: Store,
    private venue: Venue,
    private paper: Executor,
    private live: Executor | null,
    private tg: Telegram,
  ) {
    super();
  }

  start(intervalMs = 1000) {
    this.timer = setInterval(() => void this.tick(), intervalMs);
  }
  stop() {
    clearInterval(this.timer);
  }

  executor(u: UserRow): Executor | null {
    return u.mode === 'live' ? this.live : this.paper;
  }

  scannedFor(address: string) {
    return this.status.get(address)?.size ?? 0;
  }

  /** One pass: manage open positions every tick, look for new entries every second tick. */
  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      this.ticks++;
      this.metricsCache.clear();
      const users = this.store.runningUsers();
      for (const u of users) {
        try {
          await this.manage(u);
          if (this.ticks % 2 === 0) await this.scan(u);
        } catch (e) {
          console.error('[engine]', u.address, (e as Error).message);
        }
      }
      if (this.ticks % 600 === 0) {
        this.market.prune();
        this.store.pruneDecisions();
      }
    } finally {
      this.running = false;
    }
  }

  private metrics(token: string) {
    if (!this.metricsCache.has(token)) this.metricsCache.set(token, this.market.metrics(token));
    return this.metricsCache.get(token)!;
  }

  private emitUser(address: string, ev: UserEvent) {
    this.emit('user', address, ev);
  }

  /* ---------------------------------------------------------------- scan */

  private async scan(u: UserRow) {
    const s = this.store.strategy(u);
    const exec = this.executor(u);
    if (!exec) return;
    const now = this.src.now();
    const mode = u.mode as Mode;
    const stMap = this.status.get(u.address) ?? new Map<string, TokenStatus>();
    this.status.set(u.address, stMap);

    const held = new Set([...this.store.openPositions(u.address, mode).map((p) => p.token), ...this.store.openOrders(u.address).map((o) => o.token)]);

    for (const [k, st] of this.market.tokens) {
      const ageMs = now - st.launch.time;
      if (ageMs < s.ageMin * 60_000) continue; // too young to judge yet, check again later
      const prev = stMap.get(k);
      if (prev?.final || held.has(k)) continue;
      if (ageMs > (s.ageMax + 1) * 60_000) {
        if (prev) prev.final = true;
        continue;
      }
      const m = this.metrics(k);
      if (!m || m.priceEth <= 0) continue;

      const r = evaluate(m, s);
      if (r.firstFail) {
        const final = PERMANENT.has(r.firstFail);
        this.record(u, stMap, k, m, r.checks, 'skip', r.firstFail, this.failWhy(r.firstFail, r.checks), null, final);
        continue;
      }
      if (r.pending.length) continue;

      const ai = await aiScore(m, now);
      if (ai.score < s.aiMin) {
        this.record(u, stMap, k, m, r.checks, 'skip', 'ai', `AI score ${ai.score}, needs ${s.aiMin}`, ai, false);
        continue;
      }

      // every rule passed; check capacity and budget
      const open = this.store.openPositions(u.address, mode).length + this.store.openOrders(u.address).length;
      if (open >= s.maxPos) {
        this.record(u, stMap, k, m, r.checks, 'hold', null, `All ${s.maxPos} slots in use`, ai, false);
        continue;
      }
      const reserved = this.store.openOrders(u.address).reduce((a, o) => a + o.size, 0);
      if (this.store.spentSince(u.address, mode, now - DAY) + reserved + s.size > s.daily + 1e-9) {
        this.record(u, stMap, k, m, r.checks, 'hold', null, 'Daily limit reached', ai, false);
        continue;
      }
      if ((await exec.balance(u)) < s.size + 0.001) {
        this.record(u, stMap, k, m, r.checks, 'hold', null, 'Not enough ETH', ai, false);
        continue;
      }

      if (s.mode === 'limit') {
        this.store.insertOrder({
          id: newId(),
          address: u.address,
          token: k,
          size: s.size,
          trigger_price: m.priceEth * (1 - s.dip / 100),
          created: now,
          expires: now + 30 * 60_000,
          status: 'open',
          meta: JSON.stringify(this.meta(m, ai)),
        });
        this.record(u, stMap, k, m, r.checks, 'watch', null, `Buys at −${s.dip}%`, ai, true);
        held.add(k);
        continue;
      }

      const ok = await this.buyNow(u, s, k as Address, m, ai, 'Market buy');
      if (ok) {
        held.add(k);
        this.record(u, stMap, k, m, r.checks, 'buy', null, `AI ${ai.score}, every rule passed`, ai, true);
      } else this.record(u, stMap, k, m, r.checks, 'hold', null, 'Buy failed, will retry', ai, false);
    }
  }

  private failWhy(ff: Layer, checks: Check[]) {
    const bad = checks.filter((c) => !c.ok);
    return `${cap(HUMAN[ff])} · ${bad[0]?.l ?? ''}${bad.length > 1 ? ` and ${bad.length - 1} more` : ''}`;
  }

  private meta(m: TokenMetrics, ai: AiVerdict | null) {
    return {
      id: m.token.toLowerCase(),
      token: m.token,
      tk: m.symbol.toUpperCase().slice(0, 10),
      name: m.name,
      hue: hueOf(m.token.toLowerCase()),
      src: m.src,
      curve: m.curve,
      mc: Math.round(m.mc),
      liq: Math.round(m.liq),
      holders: m.holders,
      ai: { score: ai?.score ?? 0, pos: ai?.pos ?? [], neg: ai?.neg ?? [] },
    };
  }

  /** Stores and streams a decision when it is new or its outcome changed. */
  private record(
    u: UserRow,
    stMap: Map<string, TokenStatus>,
    k: string,
    m: TokenMetrics,
    checks: Check[],
    out: DecisionDTO['out'],
    ff: Layer | null,
    why: string,
    ai: AiVerdict | null,
    final: boolean,
  ) {
    const now = this.src.now();
    const prev = stMap.get(k);
    const changed = !prev || prev.out !== out || (prev.ff !== ff && now - prev.loggedAt > 5 * 60_000);
    stMap.set(k, { ff, out, loggedAt: changed ? now : prev!.loggedAt, final: final || !!prev?.final });
    if (!changed) return;
    const d: DecisionDTO = { id: newId(), time: clock(Date.now()), ts: Date.now(), out, why, ff, c: checks, t: this.meta(m, ai) as DecisionDTO['t'] };
    this.store.addDecision(u.address, d);
    this.emitUser(u.address, { type: 'decision', data: d });
  }

  /* ---------------------------------------------------------------- trading */

  private async buyNow(u: UserRow, s: Strategy, token: Address, m: TokenMetrics, ai: AiVerdict, how: string): Promise<boolean> {
    const key = `${u.address}:${token.toLowerCase()}`;
    if (this.busy.has(key)) return false;
    this.busy.add(key);
    const exec = this.executor(u)!;
    try {
      const fill = await exec.buy(u, token, toWei(s.size), s.slip);
      if (fill.tokens <= 0n) throw new Error('Filled zero tokens');
      const cost = fill.ethIn + fill.gasEth;
      const price = fill.ethIn / (Number(fill.tokens) / 1e18);
      const meta = this.meta(m, ai);
      const p: PositionRow = {
        id: newId(),
        address: u.address,
        token: token.toLowerCase(),
        mode: u.mode as Mode,
        status: 'open',
        cost_eth: cost,
        tokens: fill.tokens.toString(),
        left_tokens: fill.tokens.toString(),
        entry_price: price,
        peak_price: price,
        opened: this.src.now(),
        closed: null,
        tp1: 0,
        realized: 0,
        cfg: JSON.stringify({ tp1: s.tp1, tp2: s.tp2, sl: s.sl, trail: s.trail, maxHold: s.maxHold, devExit: s.devExit, slip: s.slip }),
        meta: JSON.stringify(meta),
      };
      this.store.insertPosition(p);
      const why = `${how} on ${fill.venue === 'curve' ? 'the Pons curve' : 'Uniswap'}. AI ${ai.score}, every rule passed.`;
      this.trade(u, 'Buy', p.token, meta, fill.ethIn, why, null, fill.tx);
      void this.tg.send(u.tg_chat, `🟢 <b>Bought $${meta.tk}</b> for ${fill.ethIn.toFixed(4)} ETH\nAI score ${ai.score}${ai.pos[0] ? ` · ${ai.pos[0]}` : ''}${u.mode === 'paper' ? '\n<i>Paper trade</i>' : ''}`);
      return true;
    } catch (e) {
      console.error('[buy]', token, (e as Error).message);
      return false;
    } finally {
      this.busy.delete(key);
    }
  }

  private trade(u: UserRow, action: 'Buy' | 'Sell' | 'Cancel', token: string, meta: object, eth: number, why: string, pnl: number | null, tx: string | null) {
    const row = { id: newId(), address: u.address, ts: Date.now(), action, token, meta: JSON.stringify(meta), eth, why, pnl, tx, mode: u.mode as Mode };
    this.store.addTrade(row);
    this.emitUser(u.address, { type: 'trade', data: tradeDTO(row) });
    this.emitUser(u.address, { type: 'state', data: null });
  }

  async sellPosition(u: UserRow, p: PositionRow, frac: number, why: string) {
    const key = `${u.address}:sell:${p.id}`;
    if (this.busy.has(key)) return;
    this.busy.add(key);
    try {
      const exec = this.executor(u);
      if (!exec) return;
      const left = BigInt(p.left_tokens);
      const amount = frac >= 1 ? left : (left * BigInt(Math.round(frac * 1000))) / 1000n;
      if (amount <= 0n) return;
      const cfg = JSON.parse(p.cfg);
      const fill = await exec.sell(u, p.token as Address, amount, cfg.slip ?? 5);
      const costPart = p.cost_eth * (Number(fill.tokens) / Number(BigInt(p.tokens)));
      const pnl = fill.ethIn - costPart - fill.gasEth;
      p.realized += pnl;
      p.left_tokens = (left - fill.tokens).toString();
      if (BigInt(p.left_tokens) <= 0n || frac >= 1) {
        p.status = 'closed';
        p.closed = this.src.now();
        p.left_tokens = '0';
      }
      this.store.updatePosition(p);
      const meta = JSON.parse(p.meta);
      this.trade(u, 'Sell', p.token, meta, fill.ethIn, why, pnl, fill.tx);
      void this.tg.send(u.tg_chat, `${pnl >= 0 ? '✅' : '🔻'} <b>Sold ${frac >= 1 ? '' : 'half of '}$${meta.tk}</b>: ${why}\n${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} ETH${u.mode === 'paper' ? '\n<i>Paper trade</i>' : ''}`);
    } catch (e) {
      console.error('[sell]', p.token, (e as Error).message);
    } finally {
      this.busy.delete(key);
    }
  }

  /* ---------------------------------------------------------------- positions */

  private async manage(u: UserRow) {
    const now = this.src.now();
    const positions = this.store.openPositions(u.address, u.mode as Mode);
    let changed = false;
    for (const p of positions) {
      const st = this.market.get(p.token);
      const left = BigInt(p.left_tokens);
      if (left <= 0n) continue;
      let value: number;
      try {
        value = toEth((await this.venue.quoteSell(p.token as Address, left)).out);
      } catch {
        continue;
      }
      const costLeft = p.cost_eth * (Number(left) / Number(BigInt(p.tokens)));
      const gain = costLeft > 0 ? (value / costLeft - 1) * 100 : 0;
      const mark = value / (Number(left) / 1e18);
      if (mark > p.peak_price) {
        p.peak_price = mark;
        this.store.updatePosition(p);
      }
      const c = JSON.parse(p.cfg) as { tp1: number; tp2: number; sl: number; trail: number; maxHold: number; devExit: boolean };
      const heldMin = (now - p.opened) / 60_000;
      if (c.devExit && st?.devSold) await this.sellPosition(u, p, 1, 'Deployer sold');
      else if (gain <= -c.sl) await this.sellPosition(u, p, 1, `Stop loss at −${c.sl}%`);
      else if (!p.tp1 && gain >= c.tp1) {
        p.tp1 = 1;
        await this.sellPosition(u, p, 0.5, `Took half at +${c.tp1}%`);
      } else if (gain >= c.tp2) await this.sellPosition(u, p, 1, `Took the rest at +${c.tp2}%`);
      else if (p.tp1 && c.trail > 0 && mark <= p.peak_price * (1 - c.trail / 100)) await this.sellPosition(u, p, 1, `Trailing stop, ${c.trail}% off the top`);
      else if (heldMin >= c.maxHold) await this.sellPosition(u, p, 1, `Held ${c.maxHold} min`);
      changed = true;
    }

    for (const o of this.store.openOrders(u.address)) {
      const st = this.market.get(o.token);
      const meta = JSON.parse(o.meta);
      if (st && st.priceEth > 0 && st.priceEth <= o.trigger_price) {
        this.store.setOrderStatus(o.id, 'filled');
        const m = this.metrics(o.token);
        if (m) await this.buyNow(u, { ...this.store.strategy(u), size: o.size }, o.token as Address, m, { ...meta.ai, summary: '', source: 'heuristic' }, 'Limit filled on dip');
      } else if (now > o.expires) {
        this.store.setOrderStatus(o.id, 'cancelled');
        this.trade(u, 'Cancel', o.token, meta, 0, 'Dip never came, order cancelled', null, null);
      }
    }
    if (changed || positions.length) this.emitUser(u.address, { type: 'positions', data: null });
  }

  /** Close everything for a user (the "Sell all & stop" button). */
  async sellAll(u: UserRow) {
    this.store.setRunning(u.address, false);
    for (const o of this.store.openOrders(u.address)) this.store.setOrderStatus(o.id, 'cancelled');
    for (const p of this.store.openPositions(u.address, u.mode as Mode)) await this.sellPosition(u, p, 1, 'Sell all & stop');
    this.emitUser(u.address, { type: 'state', data: null });
  }

  /** Live value of each open position, shaped for the website. */
  async positionsDTO(u: UserRow) {
    const now = this.src.now();
    const out = [];
    for (const p of this.store.openPositions(u.address, u.mode as Mode)) {
      const left = BigInt(p.left_tokens);
      let value = 0;
      try {
        value = toEth((await this.venue.quoteSell(p.token as Address, left)).out);
      } catch {
        /* unpriced */
      }
      const leftFrac = Number(left) / Number(BigInt(p.tokens));
      const costLeft = p.cost_eth * leftFrac;
      out.push({
        id: p.id,
        t: JSON.parse(p.meta),
        entry: 1,
        price: costLeft > 0 ? value / costLeft : 1,
        size: p.cost_eth,
        left: leftFrac,
        value,
        tp1: !!p.tp1,
        heldMin: Math.floor((now - p.opened) / 60_000),
        c: JSON.parse(p.cfg),
      });
    }
    return out;
  }

  ordersDTO(u: UserRow) {
    const now = this.src.now();
    return this.store.openOrders(u.address).map((o) => {
      const st = this.market.get(o.token);
      const usdMc = (p: number) => p * 1e9 * this.src.ethUsd();
      return { id: o.id, t: JSON.parse(o.meta), size: o.size, trigger: o.trigger_price, price: st?.priceEth ?? 0, triggerMc: usdMc(o.trigger_price), mc: usdMc(st?.priceEth ?? 0), expiresMin: Math.max(0, Math.round((o.expires - now) / 60_000)) };
    });
  }

  /** How many recent tokens a strategy would have bought, layer by layer. */
  preview(s: Strategy, limit = 300) {
    const toks = [...this.market.tokens.keys()].slice(-limit);
    const left = [0, 0, 0, 0, 0, 0];
    let n = 0;
    for (const k of toks) {
      const m = this.market.metrics(k);
      if (!m || m.priceEth <= 0) continue;
      n++;
      const r = evaluate(m, s);
      const order: Layer[] = ['src', 'mkt', 'hold', 'safe', 'soc', 'ai'];
      const failAt = r.firstFail ? order.indexOf(r.firstFail) : 5;
      for (let i = 0; i < failAt; i++) left[i]++;
      if (!r.firstFail) left[5]++; // AI layer previewed with the rules only
    }
    return { n, left };
  }
}

export function tradeDTO(r: { ts: number; action: string; meta: string; eth: number; why: string; pnl: number | null; tx: string | null; mode: string }) {
  return { time: clock(r.ts), a: r.action, t: JSON.parse(r.meta), eth: r.eth, why: r.why, pnl: r.pnl, tx: r.tx, mode: r.mode };
}
