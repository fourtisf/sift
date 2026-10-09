import { config } from '../config.js';
import type { AiVerdict, TokenMetrics } from '../types.js';

/** Deterministic fallback used when no model key is set or the model call fails. */
export function heuristicScore(m: TokenMetrics): AiVerdict {
  let s = 50;
  const pos: string[] = [];
  const neg: string[] = [];
  const f = (c: boolean, p: number, t: string) => {
    if (!c) return;
    s += p;
    (p > 0 ? pos : neg).push(t);
  };
  f(m.top10 < 22, 9, `top 10 hold only ${m.top10}%`);
  f(m.top10 > 40, -10, `top 10 hold ${m.top10}%`);
  f((m.bundle ?? 0) < 4, 8, 'no bundled wallets');
  f((m.bundle ?? 0) > 15, -14, `${m.bundle}% of supply bundled`);
  f(m.buyRatio > 1.6, 8, `${m.buyRatio}× more buying than selling`);
  f(m.buyRatio < 1, -8, 'more selling than buying');
  f(m.holders > 300, 6, `${m.holders} holders`);
  f(m.kol, 9, 'a tracked smart wallet holds it');
  f((m.xf ?? 0) > 800, 5, `active X with ${m.xf} followers`);
  f(m.dev > 8, -9, `deployer still holds ${m.dev}%`);
  f(m.rugs > 0, -18, `deployer rugged ${m.rugs}× before`);
  f(m.snipers > 15, -7, `${m.snipers} snipers early`);
  f(m.src === 'curve' && m.curve > 70, 5, `curve ${m.curve}% full, near graduation`);
  f((m.fresh ?? 0) > 45, -6, `${m.fresh}% brand-new wallets`);
  return { score: Math.max(1, Math.min(99, Math.round(s))), pos: pos.slice(0, 3), neg: neg.slice(0, 2), summary: '', source: 'heuristic' };
}

const PROMPT = (m: TokenMetrics) => `You are the final check for a memecoin trading agent on Robinhood Chain.
The token below already passed every hard rule the user set. Decide how strong an entry it is right now.

Token data (USD values, percentages of total supply):
${JSON.stringify(m, null, 1)}

Score 0-100 where 50 is neutral and 75+ means a strong entry with healthy holders, real demand and low manipulation risk.
Reply with JSON only, no prose, in this exact shape:
{"score": <int>, "positives": [<up to 3 short phrases>], "concerns": [<up to 2 short phrases>], "summary": "<one sentence>"}`;

const cache = new Map<string, { at: number; v: AiVerdict }>();

/** Scores a token with the model, cached for two minutes per token. */
export async function aiScore(m: TokenMetrics, now: number): Promise<AiVerdict> {
  const k = m.token.toLowerCase();
  const hit = cache.get(k);
  if (hit && now - hit.at < 120_000) return hit.v;
  let v: AiVerdict;
  if (!config.anthropicKey) v = heuristicScore(m);
  else {
    try {
      v = await callModel(m);
    } catch {
      v = heuristicScore(m);
    }
  }
  cache.set(k, { at: now, v });
  return v;
}

async function callModel(m: TokenMetrics): Promise<AiVerdict> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: ctl.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': config.anthropicKey!,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model: config.aiModel, max_tokens: 300, messages: [{ role: 'user', content: PROMPT(m) }] }),
    });
    if (!res.ok) throw new Error(`model ${res.status}`);
    const body = (await res.json()) as { content: { type: string; text?: string }[] };
    const text = body.content.map((c) => c.text ?? '').join('');
    return parseVerdict(text);
  } finally {
    clearTimeout(timer);
  }
}

export function parseVerdict(text: string): AiVerdict {
  const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  const o = JSON.parse(json) as { score: number; positives?: string[]; concerns?: string[]; summary?: string };
  const score = Math.max(0, Math.min(100, Math.round(Number(o.score))));
  if (!isFinite(score)) throw new Error('bad score');
  return {
    score,
    pos: (o.positives ?? []).slice(0, 3).map(String),
    neg: (o.concerns ?? []).slice(0, 2).map(String),
    summary: String(o.summary ?? ''),
    source: 'model',
  };
}
