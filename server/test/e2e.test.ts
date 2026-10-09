import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const PORT = 18000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${PORT}`;
let app: Awaited<ReturnType<typeof import('../src/index.js')['main']>>;
let token = '';
const acct = privateKeyToAccount(generatePrivateKey());

const api = async (path: string, init: RequestInit = {}) => {
  const r = await fetch(base + path, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });
  return { status: r.status, body: (await r.json()) as any };
};
const until = async (fn: () => Promise<boolean>, ms: number) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
};

beforeAll(async () => {
  process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'sift-')), 'test.db');
  process.env.PORT = String(PORT);
  process.env.SOURCE = 'demo';
  process.env.DEMO_SPEED = '120';
  const mod = await import('../src/index.js');
  app = await mod.main();
  await new Promise((r) => setTimeout(r, 300));
});

afterAll(() => {
  app.engine.stop();
  app.src.stop();
  app.server.close();
});

describe('end to end (demo market, paper trading)', () => {
  it('serves the website and health', async () => {
    const html = await (await fetch(base + '/')).text();
    expect(html).toContain('<title>');
    const h = await (await fetch(base + '/api/health')).json();
    expect(h).toMatchObject({ ok: true, source: 'demo', chainId: 4663 });
  });

  it('rejects unsigned requests and bad signatures', async () => {
    expect((await api('/api/state')).status).toBe(401);
    const { nonce } = await (await fetch(base + '/api/auth/nonce')).json();
    const message = `Sift wants you to sign in with your wallet.\n\nAddress: ${acct.address}\nNonce: ${nonce}\nChain ID: 4663\nIssued At: ${new Date().toISOString()}`;
    const other = privateKeyToAccount(generatePrivateKey());
    const signature = await other.signMessage({ message });
    const r = await fetch(base + '/api/auth/verify', { method: 'POST', body: JSON.stringify({ address: acct.address, message, signature }) });
    expect(r.status).toBe(401);
  });

  it('signs in with a wallet signature', async () => {
    const { nonce } = await (await fetch(base + '/api/auth/nonce')).json();
    const message = `Sift wants you to sign in with your wallet.\n\nAddress: ${acct.address}\nNonce: ${nonce}\nChain ID: 4663\nIssued At: ${new Date().toISOString()}`;
    const signature = await acct.signMessage({ message });
    const r = await fetch(base + '/api/auth/verify', { method: 'POST', body: JSON.stringify({ address: acct.address, message, signature }) });
    expect(r.status).toBe(200);
    token = (await r.json()).token;
    const s = await api('/api/state');
    expect(s.body).toMatchObject({ mode: 'paper', running: false, balance: 1 });
    // nonce cannot be replayed
    const again = await fetch(base + '/api/auth/verify', { method: 'POST', body: JSON.stringify({ address: acct.address, message, signature }) });
    expect(again.status).toBe(400);
  });

  it('validates and saves rules', async () => {
    const bad = await api('/api/strategy', { method: 'PUT', body: JSON.stringify({ strategy: { size: -1 } }) });
    expect(bad.status).toBe(400);
    const cur = await api('/api/strategy');
    const s = { ...cur.body.strategy, xMin: 0, size: 0.05 };
    const ok = await api('/api/strategy', { method: 'PUT', body: JSON.stringify({ strategy: s, preset: 'balanced' }) });
    expect(ok.status).toBe(200);
  });

  it('refuses live mode on a demo server', async () => {
    const r = await api('/api/mode', { method: 'POST', body: JSON.stringify({ mode: 'live' }) });
    expect(r.status).toBe(400);
  });

  it('runs the agent: decisions stream in, it buys only what passes, and sells', async () => {
    const events: string[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/stream?token=${token}`);
    ws.on('message', (m) => events.push(JSON.parse(String(m)).type));
    await api('/api/agent', { method: 'POST', body: JSON.stringify({ action: 'start' }) });

    const bought = await until(async () => (await api('/api/trades')).body.some((t: any) => t.a === 'Buy'), 90_000);
    expect(bought).toBe(true);

    const decisions = (await api('/api/decisions')).body;
    expect(decisions.length).toBeGreaterThan(5);
    // every buy decision passed every check
    for (const d of decisions.filter((d: any) => d.out === 'buy')) {
      expect(d.c.every((c: any) => c.ok)).toBe(true);
      expect(d.t.ai.score).toBeGreaterThanOrEqual(72);
    }
    // most tokens get rejected
    expect(decisions.filter((d: any) => d.out === 'skip').length).toBeGreaterThan(decisions.filter((d: any) => d.out === 'buy').length);
    expect(events).toContain('decision');
    expect(events).toContain('trade');

    const pv = await api('/api/preview', { method: 'POST', body: JSON.stringify({ strategy: (await api('/api/strategy')).body.strategy }) });
    expect(pv.body.n).toBeGreaterThan(0);

    const stop = await api('/api/agent', { method: 'POST', body: JSON.stringify({ action: 'sellall' }) });
    expect(stop.body.running).toBe(false);
    const after = await api('/api/positions');
    expect(after.body.positions.length).toBe(0);
    const trades = (await api('/api/trades')).body;
    expect(trades.some((t: any) => t.a === 'Sell')).toBe(true);
    const st = (await api('/api/state')).body;
    expect(st.balance).toBeGreaterThan(0.5);
    ws.close();
  }, 120_000);
});
