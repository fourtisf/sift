import type { Layer } from './strategy.js';

export type Address = `0x${string}`;

/* ---------- events emitted by a market source ---------- */

export interface LaunchEvent {
  token: Address;
  curve: Address;
  deployer: Address;
  pairToken: Address;
  threshold: bigint;
  block: bigint;
  time: number; // ms
  name: string;
  symbol: string;
  socials: { twitter?: string; telegram?: string; website?: string };
}

export interface TradeEvent {
  token: Address;
  venue: 'curve' | 'pool';
  side: 'buy' | 'sell';
  trader: Address;
  eth: bigint; // wei moved
  tokens: bigint; // token units moved
  block: bigint;
  time: number;
  tx: `0x${string}`;
}

export interface TransferEvent {
  token: Address;
  from: Address;
  to: Address;
  amount: bigint;
  block: bigint;
  time: number;
}

export interface CurveState {
  quoteReserve: bigint;
  tokenReserve: bigint;
  realQuoteReserve: bigint;
  sellable: bigint;
  threshold: bigint;
  feeBps: number;
  creatorTaxBps: number;
  graduated: boolean;
}

export interface PoolState {
  sqrtPriceX96: bigint;
  liquidity: bigint;
}

/* ---------- derived ---------- */

export interface TokenMetrics {
  token: Address;
  symbol: string;
  name: string;
  src: 'curve' | 'uni';
  curve: number; // % progress to graduation
  age: number; // minutes
  mc: number; // USD
  liq: number; // USD
  vol5: number; // USD
  buyRatio: number;
  holders: number;
  top10: number; // % of supply
  dev: number;
  bundle: number | null; // null while funding lookups are pending
  fresh: number | null;
  snipers: number;
  sellOk: boolean;
  renounced: boolean;
  lp: boolean;
  tax: number; // %
  rugs: number;
  x: boolean;
  tg: boolean;
  xf: number | null; // null when unknown or no X API configured
  xfPending: boolean;
  kol: boolean;
  priceEth: number; // ETH per whole token
}

export interface Check {
  g: Layer;
  l: string;
  ok: boolean;
}

export interface AiVerdict {
  score: number;
  pos: string[];
  neg: string[];
  summary: string;
  source: 'model' | 'heuristic';
}

/** Matches the shape the website renders. */
export interface DecisionDTO {
  id: string;
  time: string;
  ts: number;
  out: 'buy' | 'skip' | 'watch' | 'hold';
  why: string;
  ff: Layer | null;
  c: Check[];
  t: {
    id: string;
    token: Address;
    tk: string;
    name: string;
    hue: string;
    src: 'curve' | 'uni';
    curve: number;
    mc: number;
    liq: number;
    holders: number;
    ai: { score: number; pos: string[]; neg: string[] };
  };
}
