import { defineChain } from 'viem';
import { config } from '../config.js';

export const robinhood = defineChain({
  id: config.chainId,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [config.rpcHttp] } },
  blockExplorers: { default: { name: 'Blockscout', url: 'https://robinhoodchain.blockscout.com' } },
});

/**
 * Robinhood Chain mainnet addresses.
 * Sources: Pons V2 docs / Bitquery Pons API reference, Uniswap contracts deployments/4663.md,
 * Uniswap docs PR #1161 (Universal Router redeploy 2026-07-06). Verify on the explorer before mainnet use.
 */
export const ADDR = {
  ponsFactory: '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e',
  ponsLocker: '0x267444d099b10fb5ed7c3cc7b7c767adca574952',
  ponsHook: '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044',
  ponsRouter: '0xe33e9e479df8802cb0866d5d05258bec4cf62948',
  ponsFeeEscrow: '0xd3afeb2a57f70ef218aa82451c51b2fb0416ac9e',
  ponsBuybackVault: '0x42df2a798f82289e177311362e8f5ccc45c1219c',
  ponsGraduationExecutor: '0xc7819b64a1daecd7ec19856d026cb14efbd89046',
  poolManager: '0x8366a39cc670b4001a1121b8f6a443a643e40951',
  universalRouter: '0x06afba43fd06227fa663b0daecf536f6eaa6bf99',
  v4Quoter: '0x8dc178efb8111bb0973dd9d722ebeff267c98f94',
  stateView: '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b',
  permit2: '0x000000000022d473030f116ddee9f6b43ac78ba3',
  usdg: '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
} as const satisfies Record<string, `0x${string}`>;

export const PONS = {
  supply: 1_000_000_000n * 10n ** 18n,
  /** 5/7 of supply is sold on the curve. */
  curveSupply: (1_000_000_000n * 10n ** 18n * 5n) / 7n,
  graduatedFee: 0,
  graduatedTickSpacing: 200,
} as const;

/** Addresses that hold supply but are not real holders. */
export const NON_HOLDERS = new Set<string>([
  '0x0000000000000000000000000000000000000000',
  '0x000000000000000000000000000000000000dead',
  ADDR.ponsFactory,
  ADDR.ponsLocker,
  ADDR.poolManager,
  ADDR.ponsFeeEscrow,
  ADDR.ponsBuybackVault,
  ADDR.ponsGraduationExecutor,
]);
