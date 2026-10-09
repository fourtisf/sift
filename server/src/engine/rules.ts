import type { Strategy, Layer } from '../strategy.js';
import type { Check, TokenMetrics } from '../types.js';

const usd = (n: number) => (n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${Math.round(n)}`);

export interface RuleResult {
  checks: Check[];
  /** First layer with a failing check, or null if every rule passed. */
  firstFail: Exclude<Layer, 'ai'> | null;
  /** Metrics still being looked up; the token is re-checked later instead of rejected. */
  pending: string[];
}

/** Layers whose failure is final for a token (it will not start passing later). */
export const PERMANENT: ReadonlySet<Layer> = new Set(['safe']);

export function evaluate(m: TokenMetrics, s: Strategy): RuleResult {
  const c: Check[] = [];
  const pending: string[] = [];
  const a = (g: Exclude<Layer, 'ai'>, l: string, ok: boolean) => c.push({ g, l, ok });

  // 1. where to look
  if (s.source !== 'both') a('src', s.source === 'curve' ? 'On Pons curve' : 'Graduated', m.src === s.source);
  if (m.src === 'curve') a('src', `Curve ${m.curve}%`, m.curve >= s.curveMin && m.curve <= s.curveMax);
  a('src', `${m.age} min old`, m.age >= s.ageMin && m.age <= s.ageMax);

  // 2. market and momentum
  a('mkt', `MC ${usd(m.mc)}`, m.mc >= s.mcMin && m.mc <= s.mcMax);
  a('mkt', `Liquidity ${usd(m.liq)}`, m.liq >= s.liqMin);
  a('mkt', `5m volume ${usd(m.vol5)}`, m.vol5 >= s.vol5Min);
  a('mkt', `${m.buyRatio}× buys`, m.buyRatio >= s.buyRatio);

  // 3. holders
  a('hold', `${m.holders} holders`, m.holders >= s.holdersMin);
  a('hold', `Top 10 ${m.top10}%`, m.top10 <= s.top10Max);
  a('hold', `Deployer ${m.dev}%`, m.dev <= s.devMax);
  if (m.bundle === null) pending.push('bundles');
  else a('hold', `Bundled ${m.bundle}%`, m.bundle <= s.bundleMax);
  if (m.fresh === null) pending.push('fresh wallets');
  else a('hold', `New wallets ${m.fresh}%`, m.fresh <= s.freshMax);
  a('hold', `${m.snipers} snipers`, m.snipers <= s.snipersMax);

  // 4. contract and deployer
  if (s.sellSim) a('safe', m.sellOk ? 'Test-sell OK' : 'Honeypot', m.sellOk);
  if (s.renounced) a('safe', m.renounced ? 'Renounced' : 'Not renounced', m.renounced);
  if (s.lpLocked && m.src === 'uni') a('safe', m.lp ? 'LP locked' : 'LP unlocked', m.lp);
  a('safe', `Tax ${m.tax}%`, m.tax <= s.taxMax);
  a('safe', m.rugs ? `Deployer rugged ${m.rugs}×` : 'Clean deployer', m.rugs <= s.devRugsMax);

  // 5. social
  if (s.needSocial) a('soc', m.x || m.tg ? 'Has socials' : 'No socials', m.x || m.tg);
  if (s.xMin > 0) {
    if (m.xfPending) pending.push('X followers');
    else if (!m.x) a('soc', 'No X account', false);
    else if (m.xf !== null) a('soc', `${m.xf} X followers`, m.xf >= s.xMin);
    // follower count unavailable (no X API key): the check is skipped rather than guessed
  }
  if (s.kolOnly) a('soc', m.kol ? 'Smart wallet in' : 'No smart wallet', m.kol);

  const fail = c.find((x) => !x.ok);
  return { checks: c, firstFail: fail ? (fail.g as Exclude<Layer, 'ai'>) : null, pending };
}

export const HUMAN: Record<Layer, string> = {
  src: 'wrong age or curve',
  mkt: 'not enough buying',
  hold: 'holders look bundled',
  safe: 'contract or deployer risk',
  soc: 'no community',
  ai: 'AI not convinced',
};
