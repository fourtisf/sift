import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import { createPublicClient, http, verifyMessage, type PublicClient } from 'viem';
import { config } from '../config.js';
import { robinhood } from '../chain/robinhood.js';
import { vaultAbi, vaultFactoryAbi } from '../chain/abis.js';
import { StrategySchema } from '../strategy.js';
import type { Engine, UserEvent } from '../engine/agent.js';
import { tradeDTO } from '../engine/agent.js';
import type { Store, UserRow } from '../store/db.js';
import type { Telegram } from '../notify/telegram.js';
import type { MarketSource } from '../sources/types.js';
import type { Address } from '../types.js';

interface Deps {
  engine: Engine;
  store: Store;
  tg: Telegram;
  src: MarketSource;
  agentAddress: Address | null;
  webFile: string;
}

const COOKIE = 'sift_session';

export function signInMessage(address: string, nonce: string, issued: string) {
  return `Sift wants you to sign in with your wallet.\n\nAddress: ${address}\nNonce: ${nonce}\nChain ID: ${config.chainId}\nIssued At: ${issued}`;
}

export function startServer(d: Deps) {
  const { engine, store, tg, src } = d;
  let botName: string | null = null;
  if (config.telegramToken)
    fetch(`https://api.telegram.org/bot${config.telegramToken}/getMe`)
      .then((r) => r.json())
      .then((j: { result?: { username?: string } }) => (botName = j.result?.username ?? null))
      .catch(() => {});
  const chain: PublicClient | null =
    src.kind === 'live' ? (createPublicClient({ chain: robinhood, transport: http(config.rpcHttp) }) as PublicClient) : null;

  const json = (res: ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  };

  const readBody = (req: IncomingMessage) =>
    new Promise<any>((resolve, reject) => {
      let s = '';
      req.on('data', (c) => {
        s += c;
        if (s.length > 100_000) reject(new Error('body too large'));
      });
      req.on('end', () => {
        try {
          resolve(s ? JSON.parse(s) : {});
        } catch (e) {
          reject(e);
        }
      });
    });

  const tokenOf = (req: IncomingMessage, url?: URL) => {
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ')) return auth.slice(7);
    const c = req.headers.cookie?.split(';').map((x) => x.trim().split('=')).find(([k]) => k === COOKIE);
    if (c) return decodeURIComponent(c[1]);
    return url?.searchParams.get('token') ?? null;
  };

  const userOf = (req: IncomingMessage, url?: URL): UserRow | null => {
    const t = tokenOf(req, url);
    const a = t ? store.session(t) : null;
    return a ? store.user(a) ?? null : null;
  };

  async function state(u: UserRow) {
    const exec = engine.executor(u);
    const balance = exec ? await exec.balance(u).catch(() => 0) : 0;
    const positions = await engine.positionsDTO(u);
    const stats = store.closedStats(u.address, u.mode);
    return {
      address: u.address,
      mode: u.mode,
      running: !!u.running,
      preset: u.preset,
      balance,
      exposure: positions.reduce((a, p) => a + p.value, 0),
      realized: stats.pnl,
      wins: stats.wins ?? 0,
      closed: stats.n,
      scanned: engine.scannedFor(u.address),
      buys: store.buyCount(u.address),
      spentToday: store.spentSince(u.address, u.mode, Date.now() - 86_400_000),
      vault: u.vault,
      agent: d.agentAddress,
      factory: config.vaultFactory ?? null,
      liveAvailable: config.liveTradingEnabled && !!d.agentAddress && src.kind === 'live',
      source: src.kind,
      telegram: !!u.tg_chat,
      botAvailable: tg.enabled,
    };
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader('access-control-allow-origin', origin === 'null' ? '*' : origin);
      res.setHeader('access-control-allow-credentials', 'true');
      res.setHeader('access-control-allow-headers', 'content-type, authorization');
      res.setHeader('access-control-allow-methods', 'GET, POST, PUT, OPTIONS');
    }
    if (req.method === 'OPTIONS') return res.writeHead(204).end();

    try {
      const p = url.pathname;
      if (!p.startsWith('/api/')) {
        const html = await readFile(d.webFile);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(html);
      }

      if (p === '/api/health') return json(res, 200, { ok: true, source: src.kind, chainId: config.chainId, agent: d.agentAddress, factory: config.vaultFactory ?? null, live: config.liveTradingEnabled });

      if (p === '/api/auth/nonce') return json(res, 200, { nonce: store.newNonce(), chainId: config.chainId });

      if (p === '/api/auth/verify' && req.method === 'POST') {
        const b = await readBody(req);
        const address = String(b.address ?? '');
        const message = String(b.message ?? '');
        const signature = String(b.signature ?? '') as `0x${string}`;
        const nonce = message.match(/Nonce: (\w+)/)?.[1];
        if (!/^0x[0-9a-fA-F]{40}$/.test(address) || !nonce || !message.includes(`Address: ${address}`) || !message.includes(`Chain ID: ${config.chainId}`))
          return json(res, 400, { error: 'Malformed sign-in message' });
        if (!store.useNonce(nonce)) return json(res, 400, { error: 'Sign-in expired. Try again.' });
        const ok = await verifyMessage({ address: address as Address, message, signature }).catch(() => false);
        if (!ok) return json(res, 401, { error: 'Signature does not match this wallet' });
        store.ensureUser(address, config.paperStartEth);
        const token = store.newSession(address, config.sessionDays);
        res.setHeader('set-cookie', `${COOKIE}=${token}; HttpOnly; Path=/; Max-Age=${config.sessionDays * 86400}; SameSite=Lax`);
        return json(res, 200, { token });
      }

      const u = userOf(req, url);
      if (!u) return json(res, 401, { error: 'Sign in with your wallet first' });

      if (p === '/api/auth/logout' && req.method === 'POST') {
        const t = tokenOf(req, url);
        if (t) store.dropSession(t);
        res.setHeader('set-cookie', `${COOKIE}=; Path=/; Max-Age=0`);
        return json(res, 200, { ok: true });
      }
      if (p === '/api/state') return json(res, 200, await state(u));
      if (p === '/api/decisions') return json(res, 200, store.decisions(u.address, Number(url.searchParams.get('limit') ?? 80)));
      if (p === '/api/positions') return json(res, 200, { positions: await engine.positionsDTO(u), orders: engine.ordersDTO(u) });
      if (p === '/api/trades') return json(res, 200, store.trades(u.address, 100).map(tradeDTO));

      if (p === '/api/strategy') {
        if (req.method === 'PUT') {
          const b = await readBody(req);
          const parsed = StrategySchema.safeParse(b.strategy);
          if (!parsed.success) return json(res, 400, { error: 'Invalid rules', issues: parsed.error.issues.slice(0, 5) });
          store.setStrategy(u.address, parsed.data, String(b.preset ?? 'custom'));
          return json(res, 200, { ok: true });
        }
        return json(res, 200, { strategy: store.strategy(u), preset: u.preset });
      }

      if (p === '/api/preview' && req.method === 'POST') {
        const b = await readBody(req);
        const parsed = StrategySchema.safeParse(b.strategy);
        if (!parsed.success) return json(res, 400, { error: 'Invalid rules' });
        return json(res, 200, engine.preview(parsed.data));
      }

      if (p === '/api/agent' && req.method === 'POST') {
        const b = await readBody(req);
        if (b.action === 'start') {
          if (u.mode === 'live' && !u.vault) return json(res, 400, { error: 'Create and fund your vault first' });
          store.setRunning(u.address, true);
        } else if (b.action === 'pause') store.setRunning(u.address, false);
        else if (b.action === 'sellall') await engine.sellAll(u);
        else return json(res, 400, { error: 'Unknown action' });
        return json(res, 200, await state(store.user(u.address)!));
      }

      if (p === '/api/mode' && req.method === 'POST') {
        const b = await readBody(req);
        if (b.mode !== 'paper' && b.mode !== 'live') return json(res, 400, { error: 'Unknown mode' });
        if (b.mode === 'live') {
          if (!(config.liveTradingEnabled && d.agentAddress && src.kind === 'live')) return json(res, 400, { error: 'Live trading is not switched on for this server yet' });
          if (!u.vault) return json(res, 400, { error: 'Create your vault first' });
        }
        if (store.openPositions(u.address, u.mode).length) return json(res, 400, { error: 'Close your open positions before switching mode' });
        store.setMode(u.address, b.mode);
        store.setRunning(u.address, false);
        return json(res, 200, await state(store.user(u.address)!));
      }

      if (p === '/api/vault/refresh' && req.method === 'POST') {
        if (!chain || !config.vaultFactory) return json(res, 400, { error: 'Vaults are not configured on this server' });
        const v = (await chain.readContract({ address: config.vaultFactory, abi: vaultFactoryAbi, functionName: 'vaultOf', args: [u.address as Address] })) as Address;
        if (/^0x0+$/.test(v)) return json(res, 404, { error: 'No vault found for this wallet' });
        const [owner, agent] = await Promise.all([
          chain.readContract({ address: v, abi: vaultAbi, functionName: 'owner' }),
          chain.readContract({ address: v, abi: vaultAbi, functionName: 'agent' }),
        ]);
        if (String(owner).toLowerCase() !== u.address) return json(res, 400, { error: 'Vault owner mismatch' });
        if (!d.agentAddress || String(agent).toLowerCase() !== d.agentAddress.toLowerCase())
          return json(res, 400, { error: 'This vault does not use the Sift agent key' });
        store.setVault(u.address, v);
        return json(res, 200, await state(store.user(u.address)!));
      }

      const sellMatch = p.match(/^\/api\/positions\/([\w-]+)\/sell$/);
      if (sellMatch && req.method === 'POST') {
        const pos = store.position(sellMatch[1]);
        if (!pos || pos.address !== u.address || pos.status !== 'open') return json(res, 404, { error: 'Position not found' });
        await engine.sellPosition(u, pos, 1, 'Sold by you');
        return json(res, 200, { ok: true });
      }

      if (p === '/api/telegram/link' && req.method === 'POST') {
        if (!tg.enabled || !botName) return json(res, 400, { error: 'Telegram alerts are not set up on this server' });
        const code = randomBytes(6).toString('hex');
        store.setTelegram(u.address, u.tg_chat, code);
        return json(res, 200, { url: `https://t.me/${botName}?start=${code}` });
      }

      return json(res, 404, { error: 'Not found' });
    } catch (e) {
      console.error('[api]', (e as Error).message);
      return json(res, 500, { error: 'Something went wrong on the server' });
    }
  });

  // live updates
  const wss = new WebSocketServer({ noServer: true });
  const sockets = new Map<string, Set<WebSocket>>();
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname !== '/api/stream') return socket.destroy();
    const u = userOf(req, url);
    if (!u) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => {
      const set = sockets.get(u.address) ?? new Set();
      set.add(ws);
      sockets.set(u.address, set);
      ws.on('close', () => set.delete(ws));
    });
  });
  engine.on('user', (address: string, ev: UserEvent) => {
    const set = sockets.get(address);
    if (!set?.size) return;
    const msg = JSON.stringify(ev);
    for (const ws of set) if (ws.readyState === ws.OPEN) ws.send(msg);
  });

  server.listen(config.port, () => console.log(`[api] Sift listening on http://localhost:${config.port} (source: ${src.kind})`));
  return server;
}
