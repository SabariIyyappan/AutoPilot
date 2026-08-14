/**
 * Cost / latency / token estimation.
 *
 * Every dollar figure Autopilot ever reports traces back to `prices.json`.
 * Nothing is invented at runtime, and nothing is learned — the plan rules out
 * a learned ranker for v1 in favour of declared static priors that can be
 * inspected and argued with.
 */
import type { RecoveryAction, RiskLevel } from '../core/types.ts';

export interface ModelPrice {
  inputPerMillion: number;
  outputPerMillion: number;
  tier: string;
}

export interface PriceTable {
  charsPerToken: number;
  models: Record<string, ModelPrice>;
  modelLadder: string[];
  providerLadder: string[];
  latencyMs: Record<string, number>;
  successPriors: Record<string, number>;
}

/**
 * Token estimate from character count.
 *
 * See docs/architecture.md Q4: this build's LLM nodes do not report per-call
 * usage, so tokens are estimated from response length. Labeled an estimate
 * everywhere it surfaces rather than being passed off as measured.
 */
export function estimateTokens(text: string, charsPerToken: number): number {
  if (charsPerToken <= 0) throw new Error('charsPerToken must be positive');
  return Math.ceil(text.length / charsPerToken);
}

export function costUsd(
  prices: PriceTable,
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const price = prices.models[model];
  if (!price) throw new Error(`No declared price for model "${model}" in prices.json`);
  return (
    (inputTokens / 1_000_000) * price.inputPerMillion +
    (outputTokens / 1_000_000) * price.outputPerMillion
  );
}

/** Next model up the declared ladder, or null at the top. */
export function nextModel(prices: PriceTable, current: string): string | null {
  const i = prices.modelLadder.indexOf(current);
  if (i === -1 || i === prices.modelLadder.length - 1) return null;
  return prices.modelLadder[i + 1] ?? null;
}

/** Next provider along the declared ladder, or null at the end. */
export function nextProvider(prices: PriceTable, current: string): string | null {
  const i = prices.providerLadder.indexOf(current);
  if (i === -1 || i === prices.providerLadder.length - 1) return null;
  return prices.providerLadder[i + 1] ?? null;
}

export interface EstimateContext {
  /** Model currently configured on the failing node. */
  model: string;
  /** Tokens the original (failed) attempt consumed — the basis for re-running. */
  priorTokens: number;
}

export interface StrategyEstimate {
  expectedCostUsd: number;
  expectedLatencyMs: number;
  expectedTokens: number;
  successPrior: number;
  risk: RiskLevel;
}

const RISK_BY_ACTION: Record<RecoveryAction, RiskLevel> = {
  retry: 'LOW',
  provider_fallback: 'LOW',
  capability_swap: 'MEDIUM',
  output_repair: 'LOW',
  retrieval_refresh: 'LOW',
  // Escalating to a stronger model costs materially more — surfacing that as
  // MEDIUM lets a developer cap it via the budget's maxRisk.
  model_escalation: 'MEDIUM',
  escalate: 'LOW',
};

/**
 * Estimate the cost of one recovery strategy, BEFORE running it. This is what
 * the budget engine filters and ranks on.
 */
export function estimate(
  prices: PriceTable,
  action: RecoveryAction,
  ctx: EstimateContext,
): StrategyEstimate {
  const latency = prices.latencyMs[action] ?? 1000;
  const prior = prices.successPriors[action] ?? 0.5;
  const risk = RISK_BY_ACTION[action];

  if (action === 'escalate') {
    return {
      expectedCostUsd: 0,
      expectedLatencyMs: 0,
      expectedTokens: 0,
      successPrior: prior,
      risk,
    };
  }

  // A repair pass is cheap: it only re-processes the malformed output, not the
  // whole original prompt. Modelled as a fraction of the original call.
  const tokenMultiplier = action === 'output_repair' ? 0.35 : 1.0;
  // capability_swap re-runs a tool, not a model — no LLM tokens are spent.
  const tokens = action === 'capability_swap' ? 0 : Math.ceil(ctx.priorTokens * tokenMultiplier);

  const model = action === 'model_escalation' ? (nextModel(prices, ctx.model) ?? ctx.model) : ctx.model;

  // Split input/output evenly for estimation; exact split is unknowable
  // before the call and does not change relative ranking.
  const cost = tokens === 0 ? 0 : costUsd(prices, model, Math.ceil(tokens / 2), Math.ceil(tokens / 2));

  return {
    expectedCostUsd: cost,
    expectedLatencyMs: latency,
    expectedTokens: tokens,
    successPrior: prior,
    risk,
  };
}
