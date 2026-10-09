import type { CurveState } from '../types.js';

/**
 * Pons v2 bonding curve maths (constant product on virtual reserves).
 * Buy: trade fee, creator tax and snipe tax come off the ETH input, the rest is priced.
 * Sell: priced first, then the fees come off the ETH output.
 */
export function curveBuyOut(c: CurveState, ethIn: bigint, snipeTaxBps = 0): bigint {
  const fee = (ethIn * BigInt(c.feeBps)) / 10_000n;
  const tax = (ethIn * BigInt(c.creatorTaxBps)) / 10_000n;
  const snipe = (ethIn * BigInt(snipeTaxBps)) / 10_000n;
  const net = ethIn - fee - tax - snipe;
  if (net <= 0n) return 0n;
  const out = (net * c.tokenReserve) / (c.quoteReserve + net);
  return out > c.sellable && c.sellable > 0n ? c.sellable : out;
}

export function curveSellOut(c: CurveState, tokensIn: bigint): bigint {
  if (tokensIn <= 0n) return 0n;
  const gross = (tokensIn * c.quoteReserve) / (c.tokenReserve + tokensIn);
  const fee = (gross * BigInt(c.feeBps)) / 10_000n;
  const tax = (gross * BigInt(c.creatorTaxBps)) / 10_000n;
  return gross - fee - tax;
}

/** Apply a slippage tolerance in percent to an expected output. */
export function minOut(expected: bigint, slipPct: number): bigint {
  const bps = BigInt(Math.round(slipPct * 100));
  return (expected * (10_000n - bps)) / 10_000n;
}

export const toEth = (wei: bigint) => Number(wei) / 1e18;
export const toWei = (eth: number) => BigInt(Math.round(eth * 1e6)) * 10n ** 12n;
