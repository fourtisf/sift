import Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { PRESETS, StrategySchema, type Strategy } from '../strategy.js';
import type { DecisionDTO } from '../types.js';

export type Mode = 'paper' | 'live';

export interface UserRow {
  address: string;
  created: number;
  mode: Mode;
  running: number;
  strategy: string;
  preset: string;
  paper_eth: number;
  vault: string | null;
  tg_chat: string | null;
  tg_code: string | null;
}

export interface PositionRow {
  id: string;
  address: string;
  token: string;
  mode: Mode;
  status: 'open' | 'closed';
  cost_eth: number; // ETH spent, including the part already sold
  tokens: string; // bigint, bought
  left_tokens: string; // bigint, still held
  entry_price: number; // ETH per token
  peak_price: number;
  opened: number;
  closed: number | null;
  tp1: number;
  realized: number;
  cfg: string;
  meta: string;
}

export interface TradeRow {
  id: string;
  address: string;
  ts: number;
  action: 'Buy' | 'Sell' | 'Cancel';
  token: string;
  meta: string;
  eth: number;
  why: string;
  pnl: number | null;
  tx: string | null;
  mode: Mode;
}

export interface OrderRow {
  id: string;
  address: string;
  token: string;
  size: number;
  trigger_price: number;
  created: number;
  expires: number;
  status: 'open' | 'filled' | 'cancelled';
  meta: string;
}

export const newId = () => randomBytes(9).toString('base64url');

export class Store {
  db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      create table if not exists users(address text primary key, created integer, mode text, running integer, strategy text, preset text,
        paper_eth real, vault text, tg_chat text, tg_code text);
      create table if not exists sessions(token text primary key, address text, expires integer);
      create table if not exists nonces(nonce text primary key, created integer);
      create table if not exists decisions(id text primary key, address text, ts integer, json text);
      create index if not exists decisions_addr on decisions(address, ts);
      create table if not exists positions(id text primary key, address text, token text, mode text, status text, cost_eth real,
        tokens text, left_tokens text, entry_price real, peak_price real, opened integer, closed integer, tp1 integer, realized real, cfg text, meta text);
      create index if not exists positions_addr on positions(address, status);
      create table if not exists trades(id text primary key, address text, ts integer, action text, token text, meta text, eth real, why text, pnl real, tx text, mode text);
      create index if not exists trades_addr on trades(address, ts);
      create table if not exists orders(id text primary key, address text, token text, size real, trigger_price real, created integer, expires integer, status text, meta text);
      create table if not exists deployers(address text primary key, launches integer, rugs integer);
    `);
  }

  /* users */
  user(address: string): UserRow | undefined {
    return this.db.prepare('select * from users where address = ?').get(address.toLowerCase()) as UserRow | undefined;
  }
  ensureUser(address: string, paperEth: number): UserRow {
    const a = address.toLowerCase();
    const u = this.user(a);
    if (u) return u;
    this.db
      .prepare('insert into users(address, created, mode, running, strategy, preset, paper_eth) values (?,?,?,?,?,?,?)')
      .run(a, Date.now(), 'paper', 0, JSON.stringify(PRESETS.balanced), 'balanced', paperEth);
    return this.user(a)!;
  }
  runningUsers(): UserRow[] {
    return this.db.prepare('select * from users where running = 1').all() as UserRow[];
  }
  strategy(u: UserRow): Strategy {
    return StrategySchema.parse(JSON.parse(u.strategy));
  }
  setStrategy(address: string, s: Strategy, preset: string) {
    this.db.prepare('update users set strategy = ?, preset = ? where address = ?').run(JSON.stringify(s), preset, address.toLowerCase());
  }
  setRunning(address: string, running: boolean) {
    this.db.prepare('update users set running = ? where address = ?').run(running ? 1 : 0, address.toLowerCase());
  }
  setMode(address: string, mode: Mode) {
    this.db.prepare('update users set mode = ? where address = ?').run(mode, address.toLowerCase());
  }
  setVault(address: string, vault: string | null) {
    this.db.prepare('update users set vault = ? where address = ?').run(vault?.toLowerCase() ?? null, address.toLowerCase());
  }
  addPaper(address: string, delta: number) {
    this.db.prepare('update users set paper_eth = paper_eth + ? where address = ?').run(delta, address.toLowerCase());
  }
  setTelegram(address: string, chat: string | null, code: string | null) {
    this.db.prepare('update users set tg_chat = ?, tg_code = ? where address = ?').run(chat, code, address.toLowerCase());
  }
  userByTgCode(code: string) {
    return this.db.prepare('select * from users where tg_code = ?').get(code) as UserRow | undefined;
  }

  /* auth */
  newNonce() {
    const n = randomBytes(12).toString('hex');
    this.db.prepare('insert into nonces values (?,?)').run(n, Date.now());
    this.db.prepare('delete from nonces where created < ?').run(Date.now() - 10 * 60_000);
    return n;
  }
  useNonce(n: string) {
    const r = this.db.prepare('delete from nonces where nonce = ? and created > ?').run(n, Date.now() - 10 * 60_000);
    return r.changes === 1;
  }
  newSession(address: string, days: number) {
    const t = randomBytes(24).toString('base64url');
    this.db.prepare('insert into sessions values (?,?,?)').run(t, address.toLowerCase(), Date.now() + days * 86_400_000);
    return t;
  }
  session(token: string): string | null {
    const r = this.db.prepare('select address from sessions where token = ? and expires > ?').get(token, Date.now()) as { address: string } | undefined;
    return r?.address ?? null;
  }
  dropSession(token: string) {
    this.db.prepare('delete from sessions where token = ?').run(token);
  }

  /* decisions */
  addDecision(address: string, d: DecisionDTO) {
    this.db.prepare('insert into decisions values (?,?,?,?)').run(d.id, address, d.ts, JSON.stringify(d));
  }
  decisions(address: string, limit = 80): DecisionDTO[] {
    return (this.db.prepare('select json from decisions where address = ? order by ts desc limit ?').all(address, limit) as { json: string }[]).map((r) =>
      JSON.parse(r.json),
    );
  }
  pruneDecisions() {
    this.db.prepare('delete from decisions where ts < ?').run(Date.now() - 3 * 86_400_000);
  }

  /* positions */
  openPositions(address: string, mode?: Mode): PositionRow[] {
    return (mode
      ? this.db.prepare("select * from positions where address = ? and status = 'open' and mode = ?").all(address, mode)
      : this.db.prepare("select * from positions where address = ? and status = 'open'").all(address)) as PositionRow[];
  }
  position(id: string) {
    return this.db.prepare('select * from positions where id = ?').get(id) as PositionRow | undefined;
  }
  insertPosition(p: PositionRow) {
    this.db
      .prepare('insert into positions values (@id,@address,@token,@mode,@status,@cost_eth,@tokens,@left_tokens,@entry_price,@peak_price,@opened,@closed,@tp1,@realized,@cfg,@meta)')
      .run(p);
  }
  updatePosition(p: PositionRow) {
    this.db
      .prepare('update positions set status=@status, left_tokens=@left_tokens, peak_price=@peak_price, closed=@closed, tp1=@tp1, realized=@realized where id=@id')
      .run(p);
  }
  closedStats(address: string, mode: Mode) {
    return this.db
      .prepare("select count(*) n, sum(case when realized >= 0 then 1 else 0 end) wins, coalesce(sum(realized),0) pnl from positions where address = ? and mode = ? and status = 'closed'")
      .get(address, mode) as { n: number; wins: number | null; pnl: number };
  }

  /* trades */
  addTrade(t: TradeRow) {
    this.db.prepare('insert into trades values (@id,@address,@ts,@action,@token,@meta,@eth,@why,@pnl,@tx,@mode)').run(t);
  }
  trades(address: string, limit = 100): TradeRow[] {
    return this.db.prepare('select * from trades where address = ? order by ts desc limit ?').all(address, limit) as TradeRow[];
  }
  spentSince(address: string, mode: Mode, since: number): number {
    const r = this.db.prepare("select coalesce(sum(eth),0) s from trades where address = ? and mode = ? and action = 'Buy' and ts >= ?").get(address, mode, since) as { s: number };
    return r.s;
  }
  buyCount(address: string) {
    return (this.db.prepare("select count(*) n from trades where address = ? and action = 'Buy'").get(address) as { n: number }).n;
  }

  /* orders */
  openOrders(address: string): OrderRow[] {
    return this.db.prepare("select * from orders where address = ? and status = 'open'").all(address) as OrderRow[];
  }
  insertOrder(o: OrderRow) {
    this.db.prepare('insert into orders values (@id,@address,@token,@size,@trigger_price,@created,@expires,@status,@meta)').run(o);
  }
  setOrderStatus(id: string, status: OrderRow['status']) {
    this.db.prepare('update orders set status = ? where id = ?').run(status, id);
  }

  /* deployers */
  saveDeployer(address: string, launches: number, rugs: number) {
    this.db.prepare('insert into deployers values (?,?,?) on conflict(address) do update set launches = excluded.launches, rugs = excluded.rugs').run(address, launches, rugs);
  }
  deployers() {
    return this.db.prepare('select * from deployers').all() as { address: string; launches: number; rugs: number }[];
  }
}
