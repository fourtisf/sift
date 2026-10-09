# Sift — notes for Claude Code

Sift is an AI trading agent for **Pons memecoins on Robinhood Chain (chain id 4663)**. It only buys tokens that pass every rule the user sets (6 filter layers) plus an AI conviction score, then manages exits automatically. Users sign in with their wallet, paper-trade on real chain data, and trade live through a vault contract they own.

This is a standalone project. Do not link it to, import from, or mention any other product or brand.

## Layout

```
web/index.html        Landing page + app, one self-contained HTML file (no build step).
                      Talks to the server at the same origin (or window.SIFT_API).
                      If no server answers /api/health it runs a browser-only demo.
server/               Node 22 + TypeScript (run with tsx). SQLite via better-sqlite3.
  src/index.ts          wiring: source → market → engine → API
  src/sources/live.ts   Robinhood Chain indexer (getLogs polling over HTTP JSON-RPC)
  src/sources/demo.ts   simulated Pons market with the same events and maths
  src/market/market.ts  per-token state + metrics (holders, top10, bundles, fresh, snipers, rugs…)
  src/engine/rules.ts   the 6 filter layers, first failing layer wins
  src/engine/ai.ts      Claude API score with heuristic fallback
  src/engine/agent.ts   per-user scan / buy / limit orders / exits (TP1, TP2, SL, trail, max hold, dev-sell)
  src/trading/          curve maths, paper executor, live executor (calls the user's vault)
  src/api/server.ts     REST + WebSocket, wallet sign-in (signed message + nonce), serves web/index.html
  src/notify/telegram.ts trade alerts, "/start <code>" linking
  scripts/check-live.ts verifies every on-chain assumption against Robinhood Chain
contracts/            Foundry. SiftVault (per user) + SiftVaultFactory. script/Deploy.s.sol
```

## Commands

```bash
cd server && npm install
npm start                    # SOURCE=demo by default → http://localhost:8787
npm test                     # vitest: 20 tests incl. full sign-in → buy → sell e2e on the demo market
npm run typecheck
npm run check:live           # needs RPC_HTTP to Robinhood Chain; run before SOURCE=live

cd contracts
forge install foundry-rs/forge-std --no-git
forge test                   # 15 tests
```

Config lives in `server/.env` (copy `.env.example`). Key vars: `SOURCE`, `RPC_HTTP`, `AGENT_PRIVATE_KEY`, `VAULT_FACTORY`, `LIVE_TRADING_ENABLED`, `ANTHROPIC_API_KEY`, `TELEGRAM_BOT_TOKEN`, `X_BEARER_TOKEN`, `SMART_WALLETS`.

## Current status

Done and tested (without chain access): everything in demo mode, paper trading, API, sign-in, WebSocket stream, website wiring, vault contracts with mocks.

**Not yet verified against the real chain** (the build environment had no network access to Robinhood Chain). These came from docs and must be confirmed with `npm run check:live`:

- Pons V2 factory event `TokenLaunched(token, curve, deployer, pairToken, launchConfigId, graduationThreshold)` — topic0 matches the docs.
- Curve view functions: `getReserves`, `realQuoteReserve`, `sellableTokens`, `graduationThreshold`, `feeBps`, `creatorTaxBps`, `graduated`, and `buy(quoteIn,minTokensOut,recipient)` / `sell(tokensIn,minQuoteOut,recipient)`.
- `getTokenInfo()` layout on Pons tokens (socials). If it doesn't decode, fix `ponsTokenInfoAbi` in `src/chain/abis.ts`.
- `PoolGraduated` argument names (only the indexed `token` is used).
- Graduated pool key: ETH/token, fee 0, tickSpacing 200, Pons hook `0xe5e7…e044`. The pool fee is read from the launch record on-chain; confirm it is really 0.
- Universal Router `0x06afba43fd06227fa663b0daecf536f6eaa6bf99` (redeployed 2026-07-06) and the v4 `ExactInputSingleParams` layout used in `SiftVault._v4Swap` match the deployed router version.
- Whether all Pons curves share one runtime code hash (the vault allowlist depends on it).

## Next tasks, in order

1. Run `npm run check:live` with a paid RPC. Fix any ABI or address mismatch it reports, in `src/chain/abis.ts`, `src/chain/robinhood.ts`, `src/sources/live.ts` and, if needed, `contracts/src/SiftVault.sol`.
2. Run the server with `SOURCE=live` in paper mode for a while. Check that decisions look sane (holders, MC, bundle %, curve %), and fix metric bugs.
3. Deploy contracts: `forge script script/Deploy.s.sol --rpc-url $RPC_HTTP --private-key $DEPLOYER_KEY --broadcast`. Allowlist the curve code hash with `setCurveCode`. Set `VAULT_FACTORY` and `AGENT_PRIVATE_KEY`.
4. Small live test with 0.01 ETH limits: buy and sell one token on the curve and one graduated token through a vault. Confirm proceeds land in the vault. Only then set `LIVE_TRADING_ENABLED=true`.
5. Production hosting: Dockerfile in `server/`. Put secrets in a secrets manager. Move SQLite to Postgres before running more than one instance. Add monitoring for the agent key's gas balance.
6. Contracts need an external audit before other users trade live.

## Rules for changes

- Keep `LIVE_TRADING_ENABLED=false` until steps 1–4 pass. Never weaken vault limits or let the agent key withdraw.
- Keep the web app a single HTML file. Style: dark midnight violet (`--ink #120F24`), pastel accents, fuzzy dot mascots, Instrument Sans. No light/white backgrounds and no black-and-gold.
- Keep the browser-only demo fallback working when no server is reachable.
- Run `npm test` and `forge test` after every change.
