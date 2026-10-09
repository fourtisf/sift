import { z } from 'zod';

/** One user's trading rules. Keys match the website's Strategy screen. */
export const StrategySchema = z.object({
  source: z.enum(['curve', 'uni', 'both']),
  curveMin: z.number().min(0).max(100),
  curveMax: z.number().min(0).max(100),
  ageMin: z.number().min(0),
  ageMax: z.number().min(1),
  mcMin: z.number().min(0),
  mcMax: z.number().min(0),
  liqMin: z.number().min(0),
  vol5Min: z.number().min(0),
  buyRatio: z.number().min(0),
  holdersMin: z.number().min(0),
  top10Max: z.number().min(0).max(100),
  devMax: z.number().min(0).max(100),
  bundleMax: z.number().min(0).max(100),
  freshMax: z.number().min(0).max(100),
  snipersMax: z.number().min(0),
  sellSim: z.boolean(),
  renounced: z.boolean(),
  lpLocked: z.boolean(),
  taxMax: z.number().min(0).max(100),
  devRugsMax: z.number().min(0),
  needSocial: z.boolean(),
  xMin: z.number().min(0),
  kolOnly: z.boolean(),
  aiMin: z.number().min(0).max(100),
  mode: z.enum(['market', 'limit']),
  dip: z.number().min(0.5).max(90),
  size: z.number().positive().max(100),
  maxPos: z.number().int().min(1).max(50),
  daily: z.number().positive().max(1000),
  slip: z.number().min(0.1).max(50),
  tp1: z.number().min(1),
  tp2: z.number().min(1),
  sl: z.number().min(1).max(99),
  trail: z.number().min(0).max(99),
  maxHold: z.number().min(1),
  devExit: z.boolean(),
});
export type Strategy = z.infer<typeof StrategySchema>;

export const PRESETS: Record<'balanced' | 'safe' | 'degen', Strategy> = {
  balanced: { source: 'both', curveMin: 40, curveMax: 92, ageMin: 3, ageMax: 360, mcMin: 10000, mcMax: 500000, liqMin: 6000, vol5Min: 4000, buyRatio: 1.2, holdersMin: 120, top10Max: 30, devMax: 5, bundleMax: 10, freshMax: 30, snipersMax: 10, sellSim: true, renounced: true, lpLocked: true, taxMax: 3, devRugsMax: 0, needSocial: true, xMin: 150, kolOnly: false, aiMin: 72, mode: 'market', dip: 8, size: 0.05, maxPos: 5, daily: 1, slip: 3, tp1: 60, tp2: 200, sl: 25, trail: 20, maxHold: 120, devExit: true },
  safe: { source: 'uni', curveMin: 0, curveMax: 100, ageMin: 20, ageMax: 1440, mcMin: 50000, mcMax: 2000000, liqMin: 15000, vol5Min: 6000, buyRatio: 1.1, holdersMin: 300, top10Max: 24, devMax: 3, bundleMax: 5, freshMax: 20, snipersMax: 6, sellSim: true, renounced: true, lpLocked: true, taxMax: 1, devRugsMax: 0, needSocial: true, xMin: 500, kolOnly: false, aiMin: 78, mode: 'limit', dip: 10, size: 0.08, maxPos: 4, daily: 1, slip: 2, tp1: 40, tp2: 120, sl: 18, trail: 15, maxHold: 360, devExit: true },
  degen: { source: 'curve', curveMin: 12, curveMax: 65, ageMin: 1, ageMax: 45, mcMin: 3000, mcMax: 60000, liqMin: 0, vol5Min: 1500, buyRatio: 1.5, holdersMin: 35, top10Max: 40, devMax: 8, bundleMax: 18, freshMax: 45, snipersMax: 20, sellSim: true, renounced: false, lpLocked: false, taxMax: 5, devRugsMax: 0, needSocial: false, xMin: 0, kolOnly: false, aiMin: 62, mode: 'market', dip: 6, size: 0.02, maxPos: 8, daily: 0.5, slip: 8, tp1: 80, tp2: 400, sl: 30, trail: 25, maxHold: 40, devExit: true },
};

export const LAYERS = ['src', 'mkt', 'hold', 'safe', 'soc', 'ai'] as const;
export type Layer = (typeof LAYERS)[number];
