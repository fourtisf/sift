import type { Address, CurveState, LaunchEvent, PoolState, TradeEvent, TransferEvent } from '../types.js';

export interface SourceHandlers {
  onLaunch(e: LaunchEvent): void;
  onTrade(e: TradeEvent): void;
  onTransfer(e: TransferEvent): void;
  onGraduated(token: Address, time: number): void;
}

/**
 * Everything the engine needs from a chain. "live" reads Robinhood Chain;
 * "demo" simulates a Pons-like market so the full app runs with no RPC.
 */
export interface MarketSource {
  readonly kind: 'live' | 'demo';
  start(h: SourceHandlers): Promise<void>;
  stop(): void;
  /** Current time in ms. Demo may run faster than the wall clock. */
  now(): number;
  ethUsd(): number;
  curveState(curve: Address): Promise<CurveState>;
  poolState(token: Address): Promise<PoolState | null>;
  /** Tokens out for ethIn on the graduated pool, after pool and hook fees. */
  quotePoolBuy(token: Address, ethIn: bigint): Promise<bigint>;
  /** ETH out for tokensIn on the graduated pool. */
  quotePoolSell(token: Address, tokensIn: bigint): Promise<bigint>;
  /** First address that funded this wallet with ETH, or null if unknown. */
  funderOf(wallet: Address): Promise<Address | null>;
  /** True if the wallet has sent almost no transactions (a brand-new wallet). */
  isFresh(wallet: Address): Promise<boolean>;
  xFollowers(handle: string): Promise<number | null>;
}
