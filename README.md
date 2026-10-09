# Sift

An AI trading agent for Pons memecoins on Robinhood Chain that only buys tokens passing every rule you set, then an AI conviction check. Users sign in with their wallet, practise with paper trading on live chain data, and switch to live trading through a vault contract they own.

```
sift/
├── web/index.html      Landing page + app (single file). Talks to the server; runs a browser-only demo if no server is found.
├── server/             Node.js + TypeScript backend: indexer, filters, AI score, paper + live trading, API, Telegram.
└── contracts/          SiftVault + SiftVaultFactory (Foundry). Where live funds live.
```

## Run it locally (2 minutes, no keys needed)

```bash
cd server
npm install
cp .env.example .env        # SOURCE=demo by default
npm start                   # http://localhost:8787
```

Open http://localhost:8787, press **Meet your agent**, sign in with any browser wallet, press the switch to start the agent. It paper-trades a simulated Pons market so you can see the whole product working.

Tests:

```bash
cd server && npm test             # 20 tests: rules, curve maths, metrics, AI parsing, full sign-in → trade → sell flow
cd contracts && forge install foundry-rs/forge-std --no-git && forge test   # 15 tests: vault limits, allowlist, pause, withdraw, v4 swap encoding
```

## How it works

1. **Indexer** (`server/src/sources/live.ts`) polls Robinhood Chain logs: Pons `TokenLaunched` / `PoolGraduated`, curve `CurveBuy` / `CurveSell`, token `Transfer`, and Uniswap v4 `Swap` for graduated Pons pools.
2. **Market model** (`server/src/market/market.ts`) keeps per-token state and computes metrics: curve progress, market cap, liquidity, 5-minute volume and buy/sell ratio, holders, top 10, deployer bag, **bundles** (early buyers sharing a funder, looked up on Blockscout), **fresh wallets**, **snipers** (first 3 seconds), deployer **rug history**, socials, smart-wallet holdings.
3. **Rules** (`server/src/engine/rules.ts`) run six layers in order and stop at the first failure. Tokens with pending lookups are re-checked, not rejected.
4. **AI score** (`server/src/engine/ai.ts`) is asked only after every rule passes. Uses the Claude API when `ANTHROPIC_API_KEY` is set, otherwise a deterministic heuristic.
5. **Agent** (`server/src/engine/agent.ts`) checks every user's rules each 2 s, respects max positions and the daily budget, buys at market or places a dip limit order, and manages exits every second: sell half at TP1, rest at TP2, stop loss, trailing stop, max hold, and instant exit when the deployer sells.
6. **Execution** (`server/src/trading/executor.ts`): paper fills at live quotes; live trades go through the user's vault, on the Pons curve before graduation and on the Uniswap v4 pool after.

## The vault (live trading)

`contracts/src/SiftVault.sol` — one per user, deployed by `SiftVaultFactory`.

- The **owner** (user wallet) is the only one who can withdraw, change limits, change or remove the agent, or unpause.
- The **agent** (server key) can only call `buyOnCurve`, `sellOnCurve`, `buyOnPool`, `sellOnPool`. Proceeds always land back in the vault.
- Curve trades only work on contracts whose runtime code hash the factory admin allowlisted. Pool trades always use the Pons v4 pool key (ETH/token, Pons hook), so the agent cannot pick a different pool.
- Every buy is capped per trade and per rolling 24 h.
- Agent or owner can pause; only the owner can unpause.

Worst case if the server key leaks: an attacker can make bad trades inside vaults, bounded by each vault's daily cap. They cannot withdraw. Users can revoke the agent at any time with `setAgent(0x0)`.

## Going live — checklist

These steps need network access to Robinhood Chain and were not run from the build environment.

1. **Verify on-chain assumptions.** `cd server && RPC_HTTP=<paid rpc> npm run check:live`. It confirms the Pons event layout, curve functions, `getTokenInfo()`, the v4 pool key and quoter, and prints the curve code hash.
2. **Deploy contracts.** `cd contracts && forge script script/Deploy.s.sol --rpc-url $RPC_HTTP --private-key $DEPLOYER_KEY --broadcast`. Verify the Universal Router (`0x06afba43…bf99`, redeployed 2026-07-06), Permit2 and Pons hook addresses on Blockscout first.
3. **Allowlist the curve code hash** printed in step 1: `cast send $FACTORY "setCurveCode(bytes32,bool)" <hash> true`.
4. **Small real test.** Create a vault with 0.01 ETH limits, set `LIVE_TRADING_ENABLED=true`, buy and sell one token on the curve and one graduated token. Check the vault received the proceeds.
5. **Get the contracts audited** before opening live trading to other users.
6. Run paper trading on live data for 1–2 weeks and tune the presets on real results.

## Production notes

- Use a paid RPC; the public endpoint is rate-limited. Bundle detection calls Blockscout once per early buyer.
- The agent key pays gas for every live trade. Fund it with a little ETH and monitor it. A per-trade fee could be added in the vault if needed.
- SQLite is fine for one server. Move to Postgres before running several instances.
- Keep `AGENT_PRIVATE_KEY` in a secrets manager, never in the repo.

## Contract addresses used (Robinhood Chain, 4663)

| | |
|---|---|
| Pons V2 factory | `0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e` |
| Pons V2 meme hook | `0xe5e702641ea86f4ae6cc3cdaed2b886f976be044` |
| Uniswap v4 PoolManager | `0x8366a39cc670b4001a1121b8f6a443a643e40951` |
| Universal Router | `0x06afba43fd06227fa663b0daecf536f6eaa6bf99` |
| V4Quoter | `0x8dc178efb8111bb0973dd9d722ebeff267c98f94` |
| StateView | `0xf3334192d15450cdd385c8b70e03f9a6bd9e673b` |
| Permit2 | `0x000000000022d473030f116ddee9f6b43ac78ba3` |

Sources: Pons V2 docs, Bitquery Pons API reference, Uniswap `deployments/4663.md`, Uniswap docs PR #1161.
