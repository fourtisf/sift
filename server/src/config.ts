import 'dotenv/config';

const env = (k: string, d?: string) => {
  const v = process.env[k];
  return v === undefined || v === '' ? d : v;
};

export const config = {
  /** "demo" runs a simulated market (no RPC needed). "live" reads Robinhood Chain. */
  source: (env('SOURCE', 'demo') as 'demo' | 'live'),
  /** Demo market clock speed (10 = ten simulated seconds per real second). */
  demoSpeed: Number(env('DEMO_SPEED', '10')),
  port: Number(env('PORT', '8787')),
  publicOrigin: env('PUBLIC_ORIGIN', 'http://localhost:8787')!,
  dbPath: env('DATABASE_PATH', './sift.db')!,

  rpcHttp: env('RPC_HTTP', 'https://rpc.mainnet.chain.robinhood.com')!,
  chainId: Number(env('CHAIN_ID', '4663')),
  pollMs: Number(env('POLL_MS', '1000')),
  /** How many blocks back to scan for launches on startup (0.1s blocks; 36000 ≈ 1 hour). */
  backfillBlocks: BigInt(env('BACKFILL_BLOCKS', '36000')!),
  blockscoutApi: env('BLOCKSCOUT_API', 'https://robinhoodchain.blockscout.com/api/v2')!,

  /** The server's trading key. It is only ever the "agent" on user vaults; it never holds user funds. */
  agentPrivateKey: env('AGENT_PRIVATE_KEY') as `0x${string}` | undefined,
  vaultFactory: env('VAULT_FACTORY') as `0x${string}` | undefined,

  anthropicKey: env('ANTHROPIC_API_KEY'),
  aiModel: env('AI_MODEL', 'claude-haiku-5-5')!,

  telegramToken: env('TELEGRAM_BOT_TOKEN'),
  xBearer: env('X_BEARER_TOKEN'),
  /** Comma-separated wallets whose buys count as "smart money". */
  smartWallets: (env('SMART_WALLETS', '') || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),

  /** Starting paper balance for new users, in ETH. */
  paperStartEth: Number(env('PAPER_START_ETH', '1')),
  /** Hard switch. Live trading stays off for everyone unless this is "true". */
  liveTradingEnabled: env('LIVE_TRADING_ENABLED', 'false') === 'true',
  sessionDays: 7,
};

export type Config = typeof config;
