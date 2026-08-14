/**
 * Config + price-table loading. Isolated here so policy.ts / budget.ts /
 * estimate.ts stay pure and filesystem-free.
 */
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import type { AutopilotConfig } from './policy.ts';
import type { PriceTable } from './estimate.ts';

export function loadConfig(path: string): AutopilotConfig {
  const raw = parseYaml(readFileSync(path, 'utf8')) as AutopilotConfig;
  validateConfig(raw, path);
  return raw;
}

export function loadPrices(path: string): PriceTable {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as PriceTable;
  if (!raw.models || Object.keys(raw.models).length === 0) {
    throw new Error(`${path}: no models declared — every cost figure must resolve to a price`);
  }
  if (!raw.charsPerToken || raw.charsPerToken <= 0) {
    throw new Error(`${path}: charsPerToken must be a positive number`);
  }
  return raw;
}

/**
 * Fail loudly on a malformed config rather than silently falling back to
 * defaults — a budget that silently defaults to something permissive is worse
 * than no budget at all.
 */
function validateConfig(cfg: AutopilotConfig, path: string): void {
  if (!cfg?.budget) throw new Error(`${path}: missing required "budget" section`);
  const required = [
    'extra_cost_usd',
    'extra_latency_ms',
    'extra_tokens',
    'attempts',
    'max_risk',
  ] as const;
  for (const key of required) {
    if (cfg.budget[key] === undefined) {
      throw new Error(`${path}: budget.${key} is required`);
    }
  }
  if (!['LOW', 'MEDIUM', 'HIGH'].includes(cfg.budget.max_risk)) {
    throw new Error(`${path}: budget.max_risk must be LOW, MEDIUM or HIGH`);
  }
  if (!cfg.policy) throw new Error(`${path}: missing required "policy" section`);
  if (!cfg.ranking_weights) throw new Error(`${path}: missing required "ranking_weights" section`);
}

/** Build the initial run budget from the declared config. */
export function budgetFromConfig(cfg: AutopilotConfig) {
  return {
    remainingCostUsd: cfg.budget.extra_cost_usd,
    remainingLatencyMs: cfg.budget.extra_latency_ms,
    remainingTokens: cfg.budget.extra_tokens,
    remainingAttempts: cfg.budget.attempts,
    maxRisk: cfg.budget.max_risk,
  };
}
