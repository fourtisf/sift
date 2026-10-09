import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { config } from './config.js';
import { Market } from './market/market.js';
import { DemoSource } from './sources/demo.js';
import { LiveSource } from './sources/live.js';
import type { MarketSource } from './sources/types.js';
import { Store } from './store/db.js';
import { Engine } from './engine/agent.js';
import { LiveExecutor, PaperExecutor, Venue, type Executor } from './trading/executor.js';
import { Telegram } from './notify/telegram.js';
import { startServer } from './api/server.js';
import type { Address } from './types.js';

export async function main() {
  const store = new Store(config.dbPath);
  const src: MarketSource = config.source === 'live' ? new LiveSource() : new DemoSource(config.demoSpeed);
  const market = new Market(src, new Set(config.smartWallets));

  // restore deployer history so past rugs keep counting after a restart
  for (const d of store.deployers()) market.deployers.set(d.address, { launches: d.launches, rugs: d.rugs });
  market.onRug = (_t, dep) => {
    const s = market.deployers.get(dep.toLowerCase());
    if (s) store.saveDeployer(dep.toLowerCase(), s.launches, s.rugs);
  };

  const venue = new Venue(src, market);
  const paper = new PaperExecutor(venue, store);
  let live: Executor | null = null;
  let agentAddress: Address | null = null;
  if (config.agentPrivateKey) {
    agentAddress = privateKeyToAccount(config.agentPrivateKey).address;
    if (src.kind === 'live') live = new LiveExecutor(venue, market);
  }

  const tg = new Telegram(store);
  const engine = new Engine(src, market, store, venue, paper, live, tg);

  await src.start({
    onLaunch: (e) => market.launch(e),
    onTrade: (e) => market.trade(e),
    onTransfer: (e) => market.transfer(e),
    onGraduated: (t) => market.graduated(t),
  });

  engine.start(1000);
  tg.start();
  const here = dirname(fileURLToPath(import.meta.url));
  const server = startServer({ engine, store, tg, src, agentAddress, webFile: resolve(here, '../../web/index.html') });

  const shutdown = () => {
    engine.stop();
    src.stop();
    tg.stop();
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return { store, src, market, engine, server };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();
